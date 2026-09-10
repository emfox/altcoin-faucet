import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { AppConfig } from './config.js';
import { getPool } from './db.js';
import type { Pool } from 'mysql2/promise';
import { RpcClient } from './rpc.js';
import { verifyRecaptchaToken } from './recaptcha.js';
import { clientIpFromRequest } from './ip.js';
import { ClaimService } from './claims.js';
import { SettlementEngine } from './settle.js';
import { StatsService } from './stats.js';
import { SessionStore, safeEqual } from './session.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export interface AppContext {
  cfg: AppConfig;
  pool: Pool;
  rpc: RpcClient;
  claims: ClaimService;
  engine: SettlementEngine;
  stats: StatsService;
  sessions: SessionStore;
  realIp: (req: FastifyRequest) => string;
}

const MAX_SINGLEPAY_COIN = 1_000_000;

const CSP_PUBLIC =
  "default-src 'self'; script-src 'self' https://www.google.com https://www.gstatic.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://www.google.com; frame-src https://www.google.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
const CSP_ADMIN =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

export async function buildApp(cfg: AppConfig): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const pool = getPool(cfg);
  const rpc = new RpcClient({
    url: cfg.coin.rpcUrl,
    user: cfg.coin.rpcUser,
    password: cfg.coin.rpcPassword,
    timeoutMs: cfg.coin.rpcTimeoutMs,
  });
  const engine = new SettlementEngine(pool, rpc, cfg);
  const claims = new ClaimService(pool, rpc, cfg, engine);
  const stats = new StatsService(pool, rpc, cfg);
  const sessions = new SessionStore(cfg.admin.sessionTtlMs);

  const ctx: AppContext = {
    cfg,
    pool,
    rpc,
    claims,
    engine,
    stats,
    sessions,
    realIp: (req) => clientIpFromRequest(req, cfg),
  };

  const app = Fastify({ logger: true });

  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { global: false });

  // ---------- Security headers + per-page CSP for HTML responses ----------
  app.addHook('onSend', async (req, reply, payload) => {
    const ct = String(reply.getHeader('content-type') ?? '');
    if (!ct.includes('text/html')) return payload;
    void reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('X-Frame-Options', 'DENY')
      .header('Referrer-Policy', 'no-referrer');
    const pathname = (req.url ?? '').split('?')[0] ?? '';
    const csp = pathname.startsWith('/admin') ? CSP_ADMIN : CSP_PUBLIC;
    void reply.header('Content-Security-Policy', csp);
    return payload;
  });

  await registerStaticAndPages(app);
  registerPublicRoutes(app, ctx);
  await registerAdminRoutes(app, ctx);

  return { app, ctx };
}

async function registerStaticAndPages(app: FastifyInstance): Promise<void> {
  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: '/',
    index: ['index.html'],
  });
  // Keep the /admin URL pretty.
  app.get('/admin', async (_req, reply) => {
    return reply.redirect('/admin.html');
  });
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

function registerPublicRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/config', async (_req, reply) => {
    const c = ctx.cfg.coin;
    return reply.send({
      coin: { name: c.name, ticker: c.ticker, decimals: c.decimals, satPerCoin: c.satPerCoin, balanceMode: c.balanceMode },
      recaptchaSiteKey: ctx.cfg.recaptcha.siteKey,
      roundSize: ctx.cfg.roundSize,
      donationAddress: ctx.cfg.donationAddress,
    });
  });

  app.get('/api/stats', async (_req, reply) => {
    return reply.send(await ctx.stats.publicStats());
  });

  app.get('/api/health', async (_req, reply) => {
    let db = 'down';
    try {
      await ctx.pool.query('SELECT 1');
      db = 'up';
    } catch {
      /* down */
    }
    let rpc = 'down';
    try {
      await ctx.rpc.getBlockchainInfo();
      rpc = 'up';
    } catch {
      /* down */
    }
    return reply.send({ ok: db === 'up' && rpc === 'up', db, rpc });
  });

  app.post(
    '/api/claim',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['address', 'recaptchaToken'],
          properties: {
            address: { type: 'string', pattern: '^[A-Za-z0-9]{20,90}$' },
            recaptchaToken: { type: 'string', minLength: 20, maxLength: 16384 },
          },
        },
      },
      config: {
        rateLimit: {
          max: 20,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest) => ctx.realIp(req),
        },
      },
    },
    async (req: FastifyRequest<{ Body: { address: string; recaptchaToken: string } }>, reply) => {
      const { address, recaptchaToken } = req.body;
      const ip = ctx.realIp(req);

      const captcha = await verifyRecaptchaToken(ctx.cfg, recaptchaToken, ip);
      if (!captcha.success) {
        return reply.send({
          ok: false,
          code: 'INVALID_CAPTCHA',
          message: 'Human verification failed — please try again.',
        });
      }

      const outcome = await ctx.claims.claim({ address, ip });
      // Claims and settlements change balances/counts we cache.
      if (outcome.ok) ctx.stats.clearCache();
      return reply.send(outcome);
    },
  );
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

const ADMIN_COOKIE = 'df_admin';

function adminAuthRequired(ctx: AppContext) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const session = ctx.sessions.get(req.cookies[ADMIN_COOKIE]);
    if (!session) {
      return reply.code(401).send({ ok: false, code: 'UNAUTHORIZED', message: 'Not logged in.' });
    }
    // Extra CSRF hardening: if the browser sends an Origin it must match Host.
    const origin = req.headers.origin;
    if (origin) {
      const host = req.headers.host;
      if (!host) {
        return reply.code(403).send({ ok: false, code: 'BAD_ORIGIN', message: 'Missing Host.' });
      }
      let allowed = false;
      try {
        const o = new URL(origin);
        allowed = o.host === host;
      } catch {
        allowed = false;
      }
      if (!allowed) {
        return reply.code(403).send({ ok: false, code: 'BAD_ORIGIN', message: 'Cross-origin request rejected.' });
      }
    }
  };
}

async function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const requireAuth = adminAuthRequired(ctx);

  app.post(
    '/api/admin/login',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['username', 'password'],
          properties: { username: { type: 'string', minLength: 1, maxLength: 64 }, password: { type: 'string', minLength: 1, maxLength: 256 } },
        },
      },
      config: {
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
    },
    async (req: FastifyRequest<{ Body: { username: string; password: string } }>, reply) => {
      const { username, password } = req.body;
      if (!safeEqual(username, ctx.cfg.admin.username) || !safeEqual(password, ctx.cfg.admin.password)) {
        await new Promise((r) => setTimeout(r, 300)); // dampen brute force
        return reply.code(401).send({ ok: false, code: 'BAD_CREDENTIALS', message: 'Invalid credentials.' });
      }
      const { token, session } = ctx.sessions.create(username);
      const isSecure = String(req.headers['x-forwarded-proto'] ?? '').startsWith('https');
      void reply.setCookie(ADMIN_COOKIE, token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: isSecure,
        path: '/',
        maxAge: Math.floor(ctx.cfg.admin.sessionTtlMs / 1000),
      });
      return reply.send({ ok: true, username: session.username });
    },
  );

  app.post('/api/admin/logout', async (req, reply) => {
    const token = req.cookies[ADMIN_COOKIE];
    ctx.sessions.destroy(token);
    void reply.clearCookie(ADMIN_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });

  app.get('/api/admin/session', async (req, reply) => {
    const session = ctx.sessions.get(req.cookies[ADMIN_COOKIE]);
    return reply.send({ ok: true, authed: session !== null, username: session?.username ?? null });
  });

  app.get('/api/admin/stats', { preHandler: requireAuth }, async (_req, reply) => {
    return reply.send(await ctx.stats.adminStats());
  });

  app.post(
    '/api/admin/singlepay',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['value'],
          properties: { value: { type: 'number' } },
        },
      },
    },
    async (req: FastifyRequest<{ Body: { value: number } }>, reply) => {
      const v = req.body.value;
      if (!Number.isFinite(v) || v <= 0 || v > MAX_SINGLEPAY_COIN) {
        return reply
          .code(400)
          .send({ ok: false, code: 'BAD_VALUE', message: `singlepay must be a positive number of ${ctx.cfg.coin.name}.` });
      }
      // rounds.singlepay is a DECIMAL(20,8) column; clip to the coin precision.
      const precision = Math.min(ctx.cfg.coin.decimals, 8);
      const [res] = await ctx.pool.execute("UPDATE rounds SET singlepay = ? WHERE status = 'open'", [v.toFixed(precision)]);
      if ((res as { affectedRows: number }).affectedRows === 0) {
        return reply.code(404).send({ ok: false, code: 'NO_OPEN_ROUND', message: 'No open round.' });
      }
      ctx.stats.clearCache();
      return reply.send({ ok: true, singlepayCoin: v.toFixed(precision) });
    },
  );

  app.post(
    '/api/admin/round-no',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['value'],
          properties: { value: { type: 'integer', minimum: 1, maximum: 2147483647 } },
        },
      },
    },
    async (req: FastifyRequest<{ Body: { value: number } }>, reply) => {
      try {
        const [res] = await ctx.pool.execute("UPDATE rounds SET round_no = ? WHERE status = 'open'", [req.body.value]);
        if ((res as { affectedRows: number }).affectedRows === 0) {
          return reply.code(404).send({ ok: false, code: 'NO_OPEN_ROUND', message: 'No open round.' });
        }
      } catch (e) {
        if ((e as { code?: string }).code === 'ER_DUP_ENTRY') {
          return reply.code(409).send({ ok: false, code: 'ROUND_EXISTS', message: 'A round with that number already exists.' });
        }
        throw e;
      }
      ctx.stats.clearCache();
      return reply.send({ ok: true, roundNo: req.body.value });
    },
  );

  app.post('/api/admin/clear-round', { preHandler: requireAuth }, async (_req, reply) => {
    const result = await ctx.claims.clearCurrentRound();
    ctx.stats.clearCache();
    return reply.send({ ok: true, ...result });
  });

  app.post('/api/admin/settle', { preHandler: requireAuth }, async (_req, reply) => {
    const outcome = await ctx.engine.settleCurrentRound(true);
    ctx.stats.clearCache();
    const satPerCoin = ctx.cfg.coin.satPerCoin;
    return reply.send({
      ok: outcome.settled,
      reason: outcome.reason,
      roundNo: outcome.roundNo,
      txid: outcome.txid,
      payeeCount: outcome.payeeCount,
      requiredSat: outcome.requiredSat,
      availableSat: outcome.availableSat,
      requiredCoin: outcome.requiredSat !== undefined ? outcome.requiredSat / satPerCoin : undefined,
      availableCoin: outcome.availableSat !== undefined ? outcome.availableSat / satPerCoin : undefined,
    });
  });
}

// Re-export used by server for graceful shutdown.
export { ADMIN_COOKIE };
