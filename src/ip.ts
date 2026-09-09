import { cidrToRange, ipv4ToInt, type AppConfig } from './config.js';

/**
 * Derive the real client IP safely.
 *
 * X-Forwarded-For is only honoured when:
 *   1. the direct peer (REMOTE_ADDR / socket address) is inside a configured
 *      trusted proxy range, AND
 *   2. every entry to the right of the client entry is also a trusted proxy.
 *
 * Any malformed header causes the whole header to be ignored (never trusted).
 * Only IPv4 is supported for proxy ranges — a common setup for docker/nginx.
 */

function ipInTrustedList(ip: string, ranges: { base: number; mask: number }[]): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  return ranges.some((r) => (n & r.mask) === r.base);
}

function looksLikeIpv4(s: string): boolean {
  return ipv4ToInt(s) !== null;
}

export function clientIpFromRequest(req: { ip?: string | undefined; headers: Record<string, string | string[] | undefined> }, cfg: AppConfig): string {
  const remote = req.ip ?? 'unknown';
  const ranges = cfg.trustedProxyCidrs.map(cidrToRange).filter((r): r is { base: number; mask: number } => r !== null);

  if (ranges.length === 0 || !ipInTrustedList(remote, ranges)) {
    // Direct connection or untrusted peer: headers cannot be believed.
    return remote;
  }

  const raw = req.headers['x-forwarded-for'];
  if (raw === undefined) return remote;
  const header = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  if (header === undefined) return remote;
  const chain = header
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (chain.length === 0) return remote;

  // Walk from the right (nearest proxy) towards the client.
  for (let i = chain.length - 1; i >= 0; i--) {
    const ip = chain[i]!;
    if (!looksLikeIpv4(ip)) {
      // Malformed entry -> ignore the whole header.
      return remote;
    }
    if (ipInTrustedList(ip, ranges)) continue;
    // First untrusted address from the right = the real client.
    return ip;
  }
  // Everyone in the chain is trusted; we cannot distinguish a client.
  return remote;
}
