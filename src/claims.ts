import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { AppConfig } from './config.js';
import { RpcClient, RpcError } from './rpc.js';
import { SettlementEngine } from './settle.js';
import type { RoundRow } from './types.js';
import { ordinal } from './types.js';

/**
 * Loose local pre-check only — the authoritative validation is the coin
 * daemon's `validateaddress`. Character set is deliberately wide because
 * different altcoins use base58, bech32, or similar encodings.
 */
export const ADDRESS_RE = /^[A-Za-z0-9]{20,90}$/;

export interface ClaimOutcome {
  ok: boolean;
  code:
    | 'CLAIMED'
    | 'SETTLED_ROUND'
    | 'ROUND_FULL_WAITING_FUNDS'
    | 'INVALID_ADDRESS'
    | 'DUPLICATE_IP'
    | 'DUPLICATE_ADDRESS'
    | 'RPC_UNAVAILABLE';
  message: string;
  /** Details for verbose client display */
  submittedCount?: number;
  roundNo?: number;
  txid?: string;
}

interface OpenRoundRow extends RowDataPacket {
  id: number;
  round_no: number;
  singlepay: string;
}

export class ClaimService {
  constructor(
    private readonly pool: Pool,
    private readonly rpc: RpcClient,
    private readonly cfg: AppConfig,
    private readonly engine: SettlementEngine,
  ) {}

  /** Validate an address locally (charset/length) and with the wallet daemon. */
  async validateAddress(address: string): Promise<boolean> {
    if (!ADDRESS_RE.test(address)) return false;
    try {
      const res = await this.rpc.validateAddress(address);
      return res.isvalid === true;
    } catch (e) {
      if (e instanceof RpcError) throw e;
      return false;
    }
  }

  /**
   * Atomically register a claim for the current round. When the round reaches
   * ROUND_SIZE it triggers settlement and reports the outcome.
   *
   * The whole write path runs under the settlement engine's lock: a claim can
   * never be inserted into a round while that round is being paid out.
   */
  async claim(input: { address: string; ip: string }): Promise<ClaimOutcome> {
    const address = input.address.trim();

    let valid = false;
    try {
      valid = await this.validateAddress(address);
    } catch (e) {
      if (e instanceof RpcError) {
        return {
          ok: false,
          code: 'RPC_UNAVAILABLE',
          message: 'The wallet node is temporarily unreachable. Please try again in a moment.',
        };
      }
      throw e;
    }
    if (!valid) {
      return {
        ok: false,
        code: 'INVALID_ADDRESS',
        message: `That does not look like a valid ${this.cfg.coin.name} address.`,
      };
    }

    return this.engine.withLock(async () => {
      // 1) Make sure an open round exists (idempotent / defensive).
      const roundId = await this.ensureOpenRound();
      if (!roundId) {
        throw new Error('Could not obtain an open round');
      }

      // 2) Insert the claim — uniqueness is enforced by the database.
      let insertedId: number | null = null;
      try {
        const [res] = await this.pool.execute('INSERT INTO claims (round_id, address, ip) VALUES (?, ?, ?)', [
          roundId,
          address,
          input.ip,
        ]);
        insertedId = Number((res as { insertId: number }).insertId);
      } catch (e) {
        const err = e as { code?: string };
        if (err.code === 'ER_DUP_ENTRY') {
          return this.duplicateOutcome(roundId, address, input.ip);
        }
        throw e;
      }

      // 3) How full is the round now?
      const [countRows] = await this.pool.query<(RowDataPacket & { n: number })[]>(
        'SELECT COUNT(*) AS n FROM claims WHERE round_id = ?',
        [roundId],
      );
      const count = Number(countRows[0]!.n);
      const [roundRows] = await this.pool.query<OpenRoundRow[]>(
        'SELECT id, round_no, singlepay FROM rounds WHERE id = ?',
        [roundId],
      );
      const round = roundRows[0]!;
      const roundNo = round.round_no;
      const singlepay = round.singlepay;

      if (count < this.cfg.roundSize) {
        return {
          ok: true,
          code: 'CLAIMED',
          message: `Your claim was recorded. Payouts are sent when the round reaches ${this.cfg.roundSize} claims.`,
          submittedCount: count,
          roundNo,
        };
      }

      // 4) Round is full -> settle (we already hold the lock). If settlement
      //    raced with another request, our own round may already be paid.
      await this.engine.settleWithinLock(false);
      const mine = await this.myRoundStatus(insertedId);

      if (mine?.status === 'paid') {
        const payout = await this.roundPayout(mine.round_id);
        return {
          ok: true,
          code: 'SETTLED_ROUND',
          message: `Congratulations — your claim filled round #${mine.round_no} (the ${ordinal(count)} claim). Payouts have been sent to all ${count} participants.`,
          submittedCount: count,
          roundNo: mine.round_no,
          txid: payout?.txid,
        };
      }

      // We hit the threshold but there was not enough in the donation wallet.
      return {
        ok: true,
        code: 'ROUND_FULL_WAITING_FUNDS',
        message:
          'This round is full but the donation wallet does not yet cover the payouts. The round stays open — when funds arrive, the next claim will trigger the payout.',
        submittedCount: count,
        roundNo,
      };
    });
  }

  private async duplicateOutcome(roundId: number, address: string, ip: string): Promise<ClaimOutcome> {
    const [ipRows] = await this.pool.query<(RowDataPacket & { n: number })[]>(
      'SELECT COUNT(*) AS n FROM claims WHERE round_id = ? AND ip = ?',
      [roundId, ip],
    );
    if (Number(ipRows[0]!.n) > 0) {
      return {
        ok: false,
        code: 'DUPLICATE_IP',
        message: 'You have already claimed from this IP in the current round.',
      };
    }
    return {
      ok: false,
      code: 'DUPLICATE_ADDRESS',
      message: 'This address has already claimed in the current round.',
    };
  }

  private async ensureOpenRound(): Promise<number> {
    const [rows] = await this.pool.query<OpenRoundRow[]>(
      "SELECT id, round_no, singlepay FROM rounds WHERE status = 'open' ORDER BY id ASC LIMIT 1",
    );
    if (rows[0]) return rows[0].id;

    // No open round (shouldn't normally happen) — create the next one.
    const [maxRows] = await this.pool.query<(RowDataPacket & { m: number | null })[]>(
      'SELECT MAX(round_no) AS m FROM rounds',
    );
    const nextNo = (maxRows[0]!.m ?? 0) + 1;
    const [lastRows] = await this.pool.query<OpenRoundRow[]>(
      "SELECT singlepay FROM rounds WHERE status = 'paid' ORDER BY id DESC LIMIT 1",
    );
    const precision = Math.min(this.cfg.coin.decimals, 8);
    const singlepay = lastRows[0]?.singlepay ?? this.cfg.initialSinglepay.toFixed(precision);

    const [res] = await this.pool.execute('INSERT INTO rounds (round_no, singlepay) VALUES (?, ?)', [
      nextNo,
      singlepay,
    ]);
    return Number((res as { insertId: number }).insertId);
  }

  private async myRoundStatus(claimId: number): Promise<(RoundRow & { round_id: number }) | null> {
    const [rows] = await this.pool.query<
      (RowDataPacket & { round_id: number; round_no: number; status: 'open' | 'paid' })[]
    >(
      `SELECT r.id AS round_id, r.round_no, r.status
         FROM claims c JOIN rounds r ON r.id = c.round_id
        WHERE c.id = ?`,
      [claimId],
    );
    const row = rows[0];
    return row
      ? { id: row.round_id, round_id: row.round_id, round_no: row.round_no, status: row.status, singlepay: '', settled_at: null, created_at: new Date() }
      : null;
  }

  private async roundPayout(roundId: number): Promise<{ txid: string } | null> {
    const [rows] = await this.pool.query<(RowDataPacket & { txid: string })[]>(
      'SELECT txid FROM payouts WHERE round_id = ? LIMIT 1',
      [roundId],
    );
    return rows[0] ? { txid: rows[0].txid } : null;
  }

  /** Admin: drop every claim of the current open round. */
  async clearCurrentRound(): Promise<{ roundNo: number; deleted: number }> {
    const round = await this.currentOpenRound();
    if (!round) throw new Error('No open round');
    const [res] = await this.pool.execute('DELETE FROM claims WHERE round_id = ?', [round.id]);
    return { roundNo: round.round_no, deleted: Number((res as { affectedRows: number }).affectedRows) };
  }

  async currentOpenRound(): Promise<RoundRow | null> {
    const [rows] = await this.pool.query<RoundRow[] & RowDataPacket[]>(
      "SELECT id, round_no, singlepay, status, settled_at, created_at FROM rounds WHERE status = 'open' ORDER BY id ASC LIMIT 1",
    );
    return (rows[0] as unknown as RoundRow | undefined) ?? null;
  }
}
