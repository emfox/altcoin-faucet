import { loadConfig } from './config.js';
import { buildApp } from './http.js';

async function main(): Promise<void> {
  const cfg = loadConfig();

  const { app, ctx } = await buildApp(cfg);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await ctx.pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.listen({ port: cfg.port, host: cfg.host });
  } catch (e) {
    app.log.error(e);
    process.exit(1);
  }

  // Warm-up: surface DB / wallet availability in the logs without failing startup.
  const dbOk = await ctx.pool.query('SELECT 1').then(() => true).catch(() => false);
  let rpcOk = false;
  try {
    await ctx.rpc.getBlockchainInfo();
    rpcOk = true;
  } catch (e) {
    app.log.warn({ err: (e as Error).message }, 'devcoind unreachable at startup');
  }
  app.log.info({ dbOk, rpcOk, url: `http://${cfg.host}:${cfg.port}` }, 'faucet started');
}

main().catch((e) => {
  console.error('Fatal startup error:', e);
  process.exit(1);
});
