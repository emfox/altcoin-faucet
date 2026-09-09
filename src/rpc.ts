/**
 * Minimal typed JSON-RPC 1.0/2.0 client for bitcoin-core-compatible coin
 * daemons (Devcoin, Litecoin, Dogecoin, …). All money amounts are handled as
 * integer "sat" (1 coin = satPerCoin) internally; the RPC layer converts to
 * the float number the daemon expects.
 */

export const DEFAULT_SATS_PER_COIN = 1e8;

/** coin value (float, as the daemon speaks) -> smallest units */
export function coinToSat(coin: number, satPerCoin: number = DEFAULT_SATS_PER_COIN): number {
  return Math.round(coin * satPerCoin);
}

/** smallest units -> coin float */
export function satToCoin(sat: number, satPerCoin: number = DEFAULT_SATS_PER_COIN): number {
  return sat / satPerCoin;
}

export class RpcError extends Error {
  constructor(
    message: string,
    public readonly code: number | null,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

interface RpcResponse {
  result?: unknown;
  error?: { code: number; message: string } | null;
  id?: string | number;
}

export interface BlockchainInfo {
  blocks: number;
  difficulty: number | Record<string, number>;
  headers: number;
}

export interface NetworkInfo {
  connections: number;
  version: number;
  subversion: string;
}

export interface WalletInfo {
  balance: number;
  keypoolsize: number;
}

export interface ValidateAddressResult {
  isvalid: boolean;
  address?: string;
}

export interface WalletTransaction {
  confirmations: number;
  address?: string;
  amount?: number;
  fee?: number;
  txid?: string;
  category?: string;
  time?: number;
}

export class RpcClient {
  private readonly authHeader: string;
  private readonly idCounter = { n: 0 };

  constructor(private readonly opts: { url: string; user: string; password: string; timeoutMs: number }) {
    this.authHeader = 'Basic ' + Buffer.from(`${opts.user}:${opts.password}`).toString('base64');
  }

  private async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const id = ++this.idCounter.n;
    let res: Response;
    try {
      res = await fetch(this.opts.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: this.authHeader,
        },
        body: JSON.stringify({ jsonrpc: '1.0', id, method, params }),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (e) {
      throw new RpcError(`RPC transport error for "${method}": ${(e as Error).message}`, null);
    }
    if (!res.ok) {
      throw new RpcError(`RPC HTTP ${res.status} for "${method}"`, res.status);
    }
    let payload: RpcResponse;
    try {
      payload = (await res.json()) as RpcResponse;
    } catch {
      throw new RpcError(`RPC returned non-JSON for "${method}"`, null);
    }
    if (payload.error) {
      throw new RpcError(`RPC "${method}" error: ${payload.error.message}`, payload.error.code);
    }
    return payload.result as T;
  }

  getBlockchainInfo(): Promise<BlockchainInfo> {
    return this.call('getblockchaininfo');
  }

  getNetworkInfo(): Promise<NetworkInfo> {
    return this.call('getnetworkinfo');
  }

  getWalletInfo(): Promise<WalletInfo> {
    return this.call('getwalletinfo');
  }

  validateAddress(address: string): Promise<ValidateAddressResult> {
    return this.call('validateaddress', [address]);
  }

  /** Total received by the given label, with >= minconf confirmations (modern core). */
  getReceivedByLabel(label: string, minconf = 0): Promise<number> {
    return this.call('getreceivedbylabel', [label, minconf]);
  }

  /** Total received by the given account, with >= minconf confirmations (legacy forks). */
  getReceivedByAccount(account: string, minconf = 0): Promise<number> {
    return this.call('getreceivedbyaccount', [account, minconf]);
  }

  /**
   * Batch-pay a list of {address -> amount in coins} (float, daemon units).
   * bitcoin-core signature: sendmany "" { "addr": amount, ... }
   */
  sendMany(addresses: Record<string, number>): Promise<string> {
    return this.call('sendmany', ['', addresses]);
  }

  listTransactions(count = 50): Promise<WalletTransaction[]> {
    return this.call('listtransactions', ['*', count, 0]);
  }
}

/** Tiny TTL cache to avoid hammering devcoind on every page view. */
export class TtlCache<T> {
  private readonly store = new Map<string, { value: T; expiresAt: number }>();

  constructor(private readonly ttlMs: number) {}

  get(key: string): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T): T {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    return value;
  }

  async getOrFetch(key: string, fetchFn: () => Promise<T>): Promise<T> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await fetchFn();
    return this.set(key, value);
  }

  clear(): void {
    this.store.clear();
  }
}
