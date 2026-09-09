import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { AppConfig } from './config.js';
import { RpcClient, TtlCache, coinToSat, type WalletTransaction } from './rpc.js';
import type { RoundRow } from './types.js';

export interface CoinInfo {
  name: string;
  ticker: string;
  decimals: number;
  satPerCoin: number;
  balanceMode: 'label' | 'account' | 'none';
}

interface PublicStats {
  ok: boolean;
  coin: CoinInfo;
  blockHeight: number | null;
  difficulty: number | null;
  connections: number | null;
  donationAddress: string;
  donationBalanceSat: number | null;
  currentRoundNo: number;
  singlepaySat: number;
  roundSize: number;
  submittedInRound: number;
  /** Total amount ever paid out, in sat (sum of payouts.amount_dvc). */
  totalPayoutsSat: number;
  totalSubmissions: number;
}

export interface AdminStats extends PublicStats {
  claims: { id: number; address: string; ip: string; createdAt: string }[];
  recentTransactions: (WalletTransaction & { amountSat: number; feeSat: number })[];
  settledRounds: { roundNo: number; txid: string; amountSat: number; payeeCount: number; settledAt: string | null }[];
}

export class StatsService {
  private readonly blockchainCache: TtlCache<{ blocks: number; difficulty: number | null }>;
  private readonly networkCache: TtlCache<{ connections: number }>;
  private readonly balanceCache: TtlCache<number>;
  private readonly txsCache: TtlCache<WalletTransaction[]>;

  constructor(
    private readonly pool: Pool,
    private readonly rpc: RpcClient,
    private readonly cfg: AppConfig,
  ) {
    this.blockchainCache = new TtlCache<{ blocks: number; difficulty: number | null }>(cfg.statsCacheTtlMs);
    this.networkCache = new TtlCache<{ connections: number }>(cfg.statsCacheTtlMs);
    this.balanceCache = new TtlCache<number>(cfg.statsCacheTtlMs);
    this.txsCache = new TtlCache<WalletTransaction[]>(15_000);
  }

  clearCache(): void {
    this.balanceCache.clear();
    this.txsCache.clear();
  }

  private coinInfo(): CoinInfo {
    const c = this.cfg.coin;
    return { name: c.name, ticker: c.ticker, decimals: c.decimals, satPerCoin: c.satPerCoin, balanceMode: c.balanceMode };
  }

  async publicStats(): Promise<PublicStats> {
    const round = await this.currentRound();
    const [agg] = await this.pool.query<(RowDataPacket & { totalPayouts: string | null; totalSubmissions: number | null })[]>(
      `SELECT
         (SELECT COALESCE(SUM(amount_dvc), 0) FROM payouts) AS totalPayouts,
         (SELECT COUNT(*) FROM claims) AS totalSubmissions`,
    );

    const [countRows] = await this.pool.query<(RowDataPacket & { n: number })[]>(
      'SELECT COUNT(*) AS n FROM claims WHERE round_id = ?',
      [round?.id ?? 0],
    );

    // These are best-effort: node/donation data failing should not break the page.
    const blockchain = await this.blockchainCache
      .getOrFetch('bc', async () => {
        const info = await this.rpc.getBlockchainInfo();
        const difficulty =
          typeof info.difficulty === 'number'
            ? info.difficulty
            : info.difficulty && typeof info.difficulty === 'object'
              ? ((info.difficulty as Record<string, number>)['proof-of-work'] ?? null)
              : null;
        return { blocks: info.blocks, difficulty };
      })
      .catch(() => ({ blocks: 0, difficulty: null }));

    const network = await this.networkCache
      .getOrFetch('net', async () => {
        const info = await this.rpc.getNetworkInfo();
        return { connections: info.connections };
      })
      .catch(() => ({ connections: 0 }));

    const balanceSat = await this.balanceCache
      .getOrFetch('bal', () => this.readDonationBalanceSat())
      .catch(() => null);

    return {
      ok: true,
      coin: this.coinInfo(),
      blockHeight: blockchain.blocks || null,
      difficulty: blockchain.difficulty,
      connections: network.connections,
      donationAddress: this.cfg.donationAddress,
      donationBalanceSat: balanceSat,
      currentRoundNo: round?.round_no ?? 0,
      singlepaySat: coinToSat(Number(round?.singlepay ?? this.cfg.initialSinglepay), this.cfg.coin.satPerCoin),
      roundSize: this.cfg.roundSize,
      submittedInRound: Number(countRows[0]!.n),
      totalPayoutsSat: Number(agg[0]!.totalPayouts ?? 0),
      totalSubmissions: Number(agg[0]!.totalSubmissions ?? 0),
    };
  }

  async adminStats(): Promise<AdminStats> {
    const base = await this.publicStats();
    const round = await this.currentRound();

    const [claims] = await this.pool.query<RowDataPacket[]>(
      'SELECT id, address, ip, created_at FROM claims WHERE round_id = ? ORDER BY id DESC LIMIT 500',
      [round?.id ?? 0],
    );
    const [settled] = await this.pool.query<RowDataPacket[]>(
      `SELECT r.round_no, p.txid, p.amount_dvc, p.payee_count, p.created_at AS settled_at
         FROM payouts p JOIN rounds r ON r.id = p.round_id
        ORDER BY p.id DESC LIMIT 50`,
    );

    const txs = await this.txsCache
      .getOrFetch('txs', async () => {
        const raw = await this.rpc.listTransactions(30);
        return raw.map((t) => ({ ...t }));
      })
      .catch(() => []);

    const satPerCoin = this.cfg.coin.satPerCoin;
    return {
      ...base,
      claims: claims.map((c) => ({
        id: Number(c.id),
        address: String(c.address),
        ip: String(c.ip),
        createdAt: c.created_at instanceof Date ? c.created_at.toISOString() : String(c.created_at),
      })),
      recentTransactions: txs.map((t) => ({
        confirmations: t.confirmations,
        address: t.address ?? '',
        amount: t.amount ?? 0,
        amountSat: coinToSat(t.amount ?? 0, satPerCoin),
        fee: t.fee ?? 0,
        feeSat: coinToSat(t.fee ?? 0, satPerCoin),
        category: t.category ?? '',
        txid: t.txid ?? '',
        time: t.time ?? 0,
      })),
      settledRounds: settled.map((s) => ({
        roundNo: Number(s.round_no),
        txid: String(s.txid),
        amountSat: Number(s.amount_dvc),
        payeeCount: Number(s.payee_count),
        settledAt: s.settled_at instanceof Date ? s.settled_at.toISOString() : String(s.settled_at),
      })),
    };
  }

  private async readDonationBalanceSat(): Promise<number> {
    const mode = this.cfg.coin.balanceMode;
    if (mode === 'none') return 0;
    const coin =
      mode === 'account'
        ? await this.rpc.getReceivedByAccount(this.cfg.donationLabel, 0)
        : await this.rpc.getReceivedByLabel(this.cfg.donationLabel, 0);
    return coinToSat(coin, this.cfg.coin.satPerCoin);
  }

  private async currentRound(): Promise<RoundRow | null> {
    const [rows] = await this.pool.query<RoundRow[] & RowDataPacket[]>(
      "SELECT id, round_no, singlepay, status, settled_at, created_at FROM rounds WHERE status = 'open' ORDER BY id ASC LIMIT 1",
    );
    return (rows[0] as unknown as RoundRow | undefined) ?? null;
  }
}
