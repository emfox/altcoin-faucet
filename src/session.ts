import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Minimal in-memory admin session store.
 * Suited for a single-instance deployment; sessions do not survive restarts,
 * which is acceptable for an administrative panel.
 */

export interface Session {
  username: string;
  createdAt: number;
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly ttlMs: number) {}

  create(username: string): { token: string; session: Session } {
    this.cleanup();
    const token = randomBytes(32).toString('hex');
    const session: Session = { username, createdAt: Date.now() };
    this.sessions.set(token, session);
    return { token, session };
  }

  get(token: string | undefined): Session | null {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    if (s.createdAt + this.ttlMs < Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return s;
  }

  destroy(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [k, s] of this.sessions) {
      if (s.createdAt + this.ttlMs < now) this.sessions.delete(k);
    }
  }
}

/** Constant-time string comparison to avoid leaking env credentials via timing. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
