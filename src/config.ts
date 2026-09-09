/**
 * Centralised, validated configuration loaded from environment variables.
 * The process refuses to start when a required variable is missing/invalid.
 *
 * The faucet is coin-agnostic: point COIN_* at any bitcoin-core-compatible
 * daemon (Devcoin, Litecoin, Dogecoin, …) and the site re-brands itself.
 */

import { existsSync } from 'node:fs';

/**
 * Convenience for local development: when a .env file sits next to the CWD,
 * load it unless the variable is already set. Does not override real env.
 */
function tryLoadDotEnv(): void {
  try {
    if (existsSync('.env')) {
      process.loadEnvFile?.('.env');
    }
  } catch {
    /* .env exists but is malformed — real env vars take precedence anyway */
  }
}

export interface AppConfig {
  port: number;
  host: string;

  db: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    poolSize: number;
  };

  /** Coin daemon (bitcoin-core compatible) JSON-RPC */
  coin: {
    name: string; // display name, e.g. "Devcoin"
    ticker: string; // e.g. "DVC"
    decimals: number; // units of the smallest amount per 1 coin (sat precision), usually 8
    satPerCoin: number; // 10^decimals
    rpcUrl: string;
    rpcUser: string;
    rpcPassword: string;
    rpcTimeoutMs: number;
    /** How to read the total received by the faucet donation address. */
    balanceMode: 'label' | 'account' | 'none';
  };

  /** Wallet / donation display */
  donationLabel: string;
  donationAddress: string;

  recaptcha: {
    siteKey: string;
    secretKey: string;
    minScore: number;
  };

  /** How many unique claims fill one round */
  roundSize: number;
  /** Single payout (in whole coins) for a fresh round — used only when seeding round #1 */
  initialSinglepay: number;

  admin: {
    username: string;
    password: string;
    /** Admin session lifetime in ms */
    sessionTtlMs: number;
  };

  sessionSecret: string;

  /** Reverse proxies we trust when parsing X-Forwarded-For (IPv4 CIDRs, comma separated). Empty = do not trust any header. */
  trustedProxyCidrs: string[];

  /** TTL for cached wallet/node stats, ms */
  statsCacheTtlMs: number;

  /** Optional: enforce reCAPTCHA hostname matches (comma separated). Empty = skip hostname check. */
  allowedRecaptchaHostnames: string[];

  /** Fee reserve for the settlement balance check, in whole coins (mining/network fees on the batch). */
  feeReserve: number;
}

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v.trim();
}

/** Read `name`, falling back to the legacy aliases (helps the old devcoin env). */
function requiredAny(names: string[]): string {
  for (const n of names) {
    const v = process.env[n];
    if (v !== undefined && v.trim() !== '') return v.trim();
  }
  throw new Error(`Missing required environment variable (any of): ${names.join(', ')}`);
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function optionalAny(names: string[], fallback: string): string {
  for (const n of names) {
    const v = process.env[n];
    if (v !== undefined && v.trim() !== '') return v.trim();
  }
  return fallback;
}

function optionalInt(name: string, fallback: number): number {
  const v = optional(name, String(fallback));
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`Environment variable ${name} must be a non-negative integer, got "${v}"`);
  }
  return n;
}

function optionalFloat(name: string, fallback: number): number {
  const v = optional(name, String(fallback));
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Environment variable ${name} must be a non-negative number, got "${v}"`);
  }
  return n;
}

function optionalEnum<T extends string>(name: string, fallback: T, allowed: readonly T[]): T {
  const v = optional(name, fallback);
  if (!(allowed as readonly string[]).includes(v)) {
    throw new Error(`Environment variable ${name} must be one of ${allowed.join('|')}, got "${v}"`);
  }
  return v as T;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  tryLoadDotEnv();
  const cidrs = optional('TRUSTED_PROXY_CIDRS', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const hostnames = optional('RECAPTCHA_ALLOWED_HOSTNAMES', '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const decimals = optionalInt('COIN_DECIMALS', 8);
  if (decimals < 0 || decimals > 12) {
    throw new Error('COIN_DECIMALS must be between 0 and 12 (integer sat precision)');
  }

  const cfg: AppConfig = {
    port: optionalInt('PORT', 8080),
    host: optional('HOST', '0.0.0.0'),
    db: {
      host: optional('DB_HOST', '127.0.0.1'),
      port: optionalInt('DB_PORT', 3306),
      user: optional('DB_USER', 'faucet'),
      password: required('DB_PASSWORD'),
      database: optional('DB_NAME', 'faucet'),
      poolSize: optionalInt('DB_POOL_SIZE', 4),
    },
    coin: {
      name: optional('COIN_NAME', 'Devcoin'),
      ticker: optional('COIN_TICKER', 'DVC'),
      decimals,
      satPerCoin: Math.pow(10, decimals),
      rpcUrl: optionalAny(['COIN_RPC_URL', 'DVC_RPC_URL'], 'http://127.0.0.1:52332'),
      rpcUser: requiredAny(['COIN_RPC_USER', 'DVC_RPC_USER']),
      rpcPassword: requiredAny(['COIN_RPC_PASSWORD', 'DVC_RPC_PASSWORD']),
      rpcTimeoutMs: optionalInt('COIN_RPC_TIMEOUT_MS', 15000),
      balanceMode: optionalEnum('COIN_BALANCE_MODE', 'label', ['label', 'account', 'none']),
    },
    donationLabel: optional('DONATION_LABEL', 'FaucetDonations'),
    donationAddress: required('DONATION_ADDRESS'),
    recaptcha: {
      siteKey: required('RECAPTCHA_SITE_KEY'),
      secretKey: required('RECAPTCHA_SECRET_KEY'),
      minScore: optionalFloat('RECAPTCHA_MIN_SCORE', 0.5),
    },
    roundSize: optionalInt('ROUND_SIZE', 30),
    initialSinglepay: optionalFloat('INITIAL_SINGLEPAY', 2000),
    admin: {
      username: required('ADMIN_USERNAME'),
      password: required('ADMIN_PASSWORD'),
      sessionTtlMs: optionalInt('ADMIN_SESSION_TTL_MS', 12 * 60 * 60 * 1000),
    },
    sessionSecret: required('SESSION_SECRET'),
    trustedProxyCidrs: cidrs,
    statsCacheTtlMs: optionalInt('STATS_CACHE_TTL_MS', 30000),
    allowedRecaptchaHostnames: hostnames,
    feeReserve: optionalFloat('FEE_RESERVE', 0),
  };

  if (cfg.recaptcha.minScore < 0 || cfg.recaptcha.minScore > 1) {
    throw new Error('RECAPTCHA_MIN_SCORE must be between 0 and 1');
  }
  if (cfg.sessionSecret.length < 16) {
    throw new Error('SESSION_SECRET must be at least 16 characters');
  }
  for (const c of cidrs) {
    if (!isValidIpv4Cidr(c)) {
      throw new Error(`Invalid IPv4 CIDR in TRUSTED_PROXY_CIDRS: "${c}" (IPv4 only is supported)`);
    }
  }
  return cfg;
}

/** Loose IPv4 CIDR validation: a.b.c.d/nn */
export function isValidIpv4Cidr(s: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(s);
  if (!m) return false;
  const parts = m.slice(1, 5).map(Number);
  if (parts.some((p) => p > 255)) return false;
  const prefix = Number(m[5]);
  return prefix <= 32;
}

export function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1, 5).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

export function cidrToRange(cidr: string): { base: number; mask: number } | null {
  const [ip, pfxStr] = cidr.split('/');
  if (!ip || pfxStr === undefined) return null;
  const baseIp = ipv4ToInt(ip);
  if (baseIp === null) return null;
  const prefix = Number(pfxStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { base: (baseIp & mask) >>> 0, mask };
}
