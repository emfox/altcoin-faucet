/** Shared row / domain types. Amounts in the DB are DECIMAL strings (mysql2 returns them as strings). */

export interface RoundRow {
  id: number | bigint;
  round_no: number;
  singlepay: string; // DECIMAL as string
  status: 'open' | 'paid';
  settled_at: Date | null;
  created_at: Date;
}

export interface ClaimRow {
  id: number | bigint;
  round_id: number | bigint;
  address: string;
  ip: string;
  created_at: Date;
}

export interface PayoutRow {
  id: number | bigint;
  round_id: number | bigint;
  txid: string;
  amount_dvc: string;
  payee_count: number;
  created_at: Date;
}

export type SettlementReason = 'settled' | 'not-full' | 'insufficient-funds' | 'no-open-round' | 'already-settled';

export interface SettlementResult {
  settled: boolean;
  reason: SettlementReason;
  roundNo?: number;
  txid?: string;
  payeeCount?: number;
  totalSat?: number;
  requiredSat?: number;
  availableSat?: number;
}

export type ClaimDisposition =
  | { status: 'ok' }
  | { status: 'duplicate-ip' }
  | { status: 'duplicate-address' };

export const ORDINALS = ['th', 'st', 'nd', 'rd'] as const;

export function ordinal(n: number): string {
  const abs = Math.abs(n);
  const mod100 = abs % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const mod10 = abs % 10;
  const suffix = mod10 <= 3 ? ORDINALS[mod10]! : 'th';
  return `${n}${suffix}`;
}
