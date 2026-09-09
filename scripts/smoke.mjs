#!/usr/bin/env node
/**
 * Smoke harness for the faucet that does not require MySQL.
 *
 * Starts a fake devcoind JSON-RPC server and boots the compiled app pointing
 * at it (DB is intentionally unreachable). Verifies:
 *   - static pages + CSP headers
 *   - public config/stats health responses
 *   - RpcClient request/response handling against the mock daemon
 *   - admin login (success + failure), cookie issuance, auth-gating
 *
 * Run from the project root:  node scripts/smoke.mjs
 * Exits non-zero on the first failing assertion.
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK_PORT = 19001;
const APP_PORT = 19080;
const RPC_USER = 'rpcuser';
const RPC_PASS = 'rpcpass';

const rpcCalls = [];
let lastSendmanyPayload = null;

// ---------------------------------------------------------------- mock daemon
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let call;
    try {
      call = JSON.parse(body);
    } catch {
      res.writeHead(400).end('bad json');
      return;
    }
    rpcCalls.push(call.method);
    const params = call.params ?? [];
    let result;
    switch (call.method) {
      case 'getblockchaininfo':
        result = { blocks: 1234567, headers: 1234567, difficulty: { 'proof-of-work': 1234567.890123, 'proof-of-stake': 0 } };
        break;
      case 'getnetworkinfo':
        result = { connections: 8, version: 250000, subversion: '/Satoshi:25.0.0/' };
        break;
      case 'validateaddress':
        result = { isvalid: true, address: params[0] };
        break;
      case 'getreceivedbylabel':
        result = 250000.0; // DVC
        break;
      case 'sendmany':
        lastSendmanyPayload = params;
        result = 'a'.repeat(64);
        break;
      case 'listtransactions':
        result = [{ confirmations: 12, address: 'DBtc1', amount: 123.45, fee: 0, category: 'receive', txid: 'b'.repeat(64), time: 1700000000 }];
        break;
      default:
        res.writeHead(500).end(JSON.stringify({ result: null, error: { code: -32601, message: `method not found: ${call.method}` }, id: call.id }));
        return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ result, error: null, id: call.id }));
  });
});

// --------------------------------------------------------------- RPC client
async function checkRpcClient() {
  const { RpcClient, coinToSat, satToCoin } = await import(pathToFileURL(path.join(root, 'dist', 'rpc.js')).href);
  const client = new RpcClient({
    url: `http://127.0.0.1:${MOCK_PORT}`,
    user: RPC_USER,
    password: RPC_PASS,
    timeoutMs: 5000,
  });
  const satPerCoin = 1e8;
  const bc = await client.getBlockchainInfo();
  assert.equal(bc.blocks, 1234567, 'getblockchaininfo.blocks');
  const va = await client.validateAddress('Dabc123');
  assert.equal(va.isvalid, true, 'validateaddress result');
  const bal = await client.getReceivedByLabel('FaucetDonations');
  assert.equal(coinToSat(bal, satPerCoin), 25_000_000_000_000, 'coinToSat(250000 coins)');
  assert.equal(satToCoin(1e8, satPerCoin), 1, 'satToCoin roundtrip');
  const txid = await client.sendMany({ Dbaba: 0.005, Dcaca: 0.006 });
  assert.equal(txid.length, 64, 'sendmany txid');
  assert.equal(lastSendmanyPayload[1].Dbaba, 0.005, 'sendmany amounts passthrough');
  console.log('  ok  RpcClient against mock daemon');
}

// --------------------------------------------------------------------- boots
const env = {
  ...process.env,
  PORT: String(APP_PORT),
  HOST: '127.0.0.1',
  DB_HOST: '127.0.0.1',
  DB_PORT: '3399',
  DB_NAME: 'faucet',
  DB_USER: 'faucet',
  DB_PASSWORD: 'whatever',
  COIN_NAME: 'Testcoin',
  COIN_TICKER: 'TST',
  COIN_DECIMALS: '8',
  COIN_RPC_URL: `http://127.0.0.1:${MOCK_PORT}`,
  COIN_RPC_USER: RPC_USER,
  COIN_RPC_PASSWORD: RPC_PASS,
  DONATION_ADDRESS: 'DdonationAddr1111',
  RECAPTCHA_SITE_KEY: 'site_key_placeholder',
  RECAPTCHA_SECRET_KEY: 'secret_key_placeholder',
  ADMIN_USERNAME: 'rootadmin',
  ADMIN_PASSWORD: 's3cret!pass',
  SESSION_SECRET: '0123456789abcdef0123456789abcdef',
  ROUND_SIZE: '3', // small round for later manual DB tests
  INITIAL_SINGLEPAY: '0.5',
};

const app = spawn(process.execPath, ['dist/server.js'], {
  cwd: root,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

function logs() {
  app.stdout.pipe(process.stdout);
  app.stderr.pipe(process.stderr);
}

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${APP_PORT}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('app did not become ready');
}

async function request(method, p, opts = {}) {
  const res = await fetch(`http://127.0.0.1:${APP_PORT}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: 'manual',
  });
  return res;
}

async function main() {
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
  console.log('mock devcoind listening on', MOCK_PORT);

  await checkRpcClient();

  app.on('error', (e) => {
    console.error('app spawn error:', e);
    process.exitCode = 1;
  });
  logs();
  await waitReady();
  console.log('app is up on', APP_PORT);

  // ---- static pages & security headers
  let res = await request('GET', '/');
  assert.equal(res.status, 200, 'GET /');
  let html = await res.text();
  assert.ok(html.includes('Altcoin Faucet'), 'index html title');
  assert.ok(res.headers.get('content-security-policy'), 'index CSP header present');
  assert.equal(res.headers.get('x-frame-options'), 'DENY', 'XFO header');

  res = await request('GET', '/admin');
  assert.equal(res.status, 302, 'GET /admin redirects to /admin.html');
  assert.equal(res.headers.get('location'), '/admin.html', 'redirect location');
  res = await request('GET', '/admin.html');
  assert.equal(res.status, 200, 'GET /admin.html');
  html = await res.text();
  assert.ok(html.includes('Administrator sign in'), 'admin html');
  const adminCsp = res.headers.get('content-security-policy') ?? '';
  assert.ok(!adminCsp.includes('google.com'), 'admin CSP must not allow google (recaptcha) script');

  res = await request('GET', '/style.css');
  assert.equal(res.status, 200, 'static css');

  res = await request('GET', '/api/config');
  const cfg = await res.json();
  assert.equal(cfg.recaptchaSiteKey, 'site_key_placeholder', '/api/config site key');
  assert.equal(cfg.coin.ticker, 'TST', '/api/config exposes coin ticker');
  assert.equal(cfg.coin.decimals, 8, '/api/config exposes coin decimals');

  // ---- health reports db down + rpc up
  res = await request('GET', '/api/health');
  const health = await res.json();
  assert.equal(health.db, 'down', 'health.db');
  assert.equal(health.rpc, 'up', 'health.rpc');
  console.log('  ok  health endpoint (db down expected, rpc up)');

  // ---- admin auth
  res = await request('POST', '/api/admin/login', { body: { username: 'rootadmin', password: 'wrong' } });
  assert.equal(res.status, 401, 'login rejects bad credentials');

  res = await request('POST', '/api/admin/login', { body: { username: 'rootadmin', password: 's3cret!pass' } });
  assert.equal(res.status, 200, 'login accepts good credentials');
  const cookie = res.headers.get('set-cookie') ?? '';
  assert.ok(cookie.includes('df_admin='), 'session cookie issued');
  assert.ok(cookie.toLowerCase().includes('httponly'), 'cookie httpOnly');
  assert.ok(cookie.toLowerCase().includes('samesite=strict'), 'cookie sameSite=strict');
  console.log('  ok  admin login + cookie flags');

  res = await request('GET', '/api/admin/session');
  assert.equal((await res.json()).authed, false, 'session unauth when no cookie');

  res = await request('GET', '/api/admin/stats');
  assert.equal(res.status, 401, 'admin stats gated without cookie');

  // Cookie present but DB is down → expect a 500 from the DB layer (auth passed).
  const cookieHeader = cookie.split(';')[0];
  res = await request('GET', '/api/admin/stats', { headers: { cookie: cookieHeader } });
  assert.equal(res.status, 500, 'admin stats w/ cookie but DB down → 500 (auth ok, db missing)');
  console.log('  ok  admin stats auth-gating (auth passed → db 500 as expected)');

  // claim endpoint with a garbage captcha token should fail closed without
  // ever touching the RPC layer (captcha gateway may be unreachable offline)
  res = await request('POST', '/api/claim', { body: { address: 'D' + 'a'.repeat(30), recaptchaToken: 'x'.repeat(80) } });
  const claim = await res.json();
  assert.equal(claim.code, 'INVALID_CAPTCHA', 'claim fails closed on captcha');
  console.log('  ok  claim captcha fail-closed');

  // body validation: bad address shape rejected by JSON schema (400)
  res = await request('POST', '/api/claim', { body: { address: 'not an address!!', recaptchaToken: 'x'.repeat(80) } });
  assert.equal(res.status, 400, 'claim rejects malformed body');

  console.log('\nALL SMOKE CHECKS PASSED');
}

main()
  .catch((e) => {
    console.error('\nSMOKE FAILURE:', e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    app.kill('SIGTERM');
    mock.close();
    setTimeout(() => process.exit(process.exitCode ?? 0), 300);
  });
