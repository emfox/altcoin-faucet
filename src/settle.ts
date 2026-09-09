import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { AppConfig } from './config.js';
import { RpcClient, coinToSat, satToCoin } from './rpc.js';
import type { RoundRow, SettlementResult } from './types.js';

/**
 * Round settlement engine.
 *
 * All settlement is serialised through an in-process mutex and additionally
 * protected with SELECT ... FOR UPDATE, so only one settlement can run at a
 * time even across multiple app instances.
 *
 * Order of operations inside the transaction:
 *   1. lock the current open round,
 *   2. count claims — below the threshold we do nothing,
 *   3. check the donation balance covers the batch (+ fee reserve),
 *   4. sendmany, then record the payout and open the next round,
 *   5. commit.
 *
 * sendmany is intentionally called *inside* the transaction window so the
 * DB and the wallet stay consistent; the window is short (~a few hundred ms).
 */

export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    return prev.then(() => fn()).finally(release);
  }
}

export class SettlementEngine {
  private readonly mutex = new Mutex();

  constructor(
    private readonly pool: Pool,
    private readonly rpc: RpcClient,
    private readonly cfg: AppConfig,
  ) {}

  /**
   * Run `fn` exclusively against the settlement engine. Claim writers and the
   * settlement itself share this lock so a claim can never land in a round
   * that is being paid out at the same moment.
   */
  withLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.mutex.runExclusive(fn);
  }

  /**
   * Try to settle the current open round. Safe to call after every claim and
   * from the admin panel ("settle now").
   */
  async settleCurrentRound(force: boolean): Promise<SettlementResult> {
    return this.withLock(() => this.settleInner(force));
  }

  /**
   * Same as settleCurrentRound but MUST only be called while the caller
   * already holds the lock (from inside withLock). Internal use.
   */
  settleWithinLock(force: boolean): Promise<SettlementResult> {
    return this.settleInner(force);
  }

  /**
   * Total received by the donation address, via the configured API flavour.
   * bitcoin-core ≥ 0.17 uses labels; old forks (Devcoin-era daemons) use
   * accounts. `none` disables the check entirely.
   */
  private async readDonationBalance(): Promise<number> {
    const mode = this.cfg.coin.balanceMode;
    if (mode === 'none') return 0;
    if (mode === 'account') {
      return this.rpc.getReceivedByAccount(this.cfg.donationLabel, 0);
    }
    return this.rpc.getReceivedByLabel(this.cfg.donationLabel, 0);
  }

  private async settleInner(force: boolean): Promise<SettlementResult> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await this.settleInTransaction(conn, force);
      await conn.commit();
      return result;
    } catch (e) {
      await conn.rollback().catch(() => undefined);
      throw e;
    } finally {
      conn.release();
    }
  }

  private async settleInTransaction(conn: PoolConnection, force: boolean): Promise<SettlementResult> {
    const [roundRows] = await conn.query<RoundRow[] & RowDataPacket[]>(
      `SELECT id, round_no, singlepay, status, settled_at, created_at
         FROM rounds WHERE status = 'open'
        ORDER BY id ASC LIMIT 1 FOR UPDATE`,
    );
    const round = roundRows[0] as unknown as RoundRow | undefined;
    if (!round) {
      return { settled: false, reason: 'no-open-round' };
    }

    const [countRows] = await conn.query<(RowDataPacket & { n: number })[]>(
      'SELECT COUNT(*) AS n FROM claims WHERE round_id = ?',
      [round.id],
    );
    const count = Number(countRows[0]!.n);

    // A payout record for this round means the money already went out once.
    const [payRows] = await conn.query<(RowDataPacket & { n: number })[]>(
      'SELECT COUNT(*) AS n FROM payouts WHERE round_id = ?',
      [round.id],
    );
    const alreadyPaid = Number(payRows[0]!.n) > 0;

    if (alreadyPaid) {
      return { settled: false, reason: 'already-settled', roundNo: round.round_no };
    }

    if (!force && count < this.cfg.roundSize) {
      return { settled: false, reason: 'not-full', roundNo: round.round_no };
    }

    if (count === 0) {
      return { settled: false, reason: 'not-full', roundNo: round.round_no };
    }

    const satPerCoin = this.cfg.coin.satPerCoin;
    const singlepaySat = coinToSat(Number(round.singlepay), satPerCoin);
    const totalSat = singlepaySat * count;
    const reserveSat = coinToSat(this.cfg.feeReserve, satPerCoin);

    // Live balance check (deliberately not cached).
    const balanceCoin = await this.readDonationBalance();
    const availableSat = coinToSat(balanceCoin, satPerCoin);

    if (availableSat < totalSat + reserveSat) {
      return {
        settled: false,
        reason: 'insufficient-funds',
        roundNo: round.round_no,
        requiredSat: totalSat + reserveSat,
        availableSat,
      };
    }

    const [claimRows] = await conn.query<(RowDataPacket & { address: string })[]>(
      'SELECT address FROM claims WHERE round_id = ?',
      [round.id],
    );

    const payees: Record<string, number> = {};
    for (const r of claimRows) {
      payees[r.address] = satToCoin(singlepaySat, satPerCoin);
    }

    // The actual money movement — inside the transaction window, see header comment.
    const txid = await this.rpc.sendMany(payees);

    await conn.query(
      'INSERT INTO payouts (round_id, txid, amount_dvc, payee_count) VALUES (?, ?, ?, ?)',
      [round.id, txid, String(totalSat), count],
    );
    await conn.query("UPDATE rounds SET status = 'paid', settled_at = UTC_TIMESTAMP(3) WHERE id = ?", [
      round.id,
    ]);
    await conn.query('INSERT INTO rounds (round_no, singlepay) VALUES (?, ?)', [
      round.round_no + 1,
      round.singlepay,
    ]);

    return {
      settled: true,
      reason: 'settled',
      roundNo: round.round_no,
      txid,
      payeeCount: count,
      totalSat,
      requiredSat: totalSat + reserveSat,
      availableSat,
    };
  }
}
