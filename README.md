# Altcoin Faucet

A coin-agnostic faucet: visitors claim once per round and get paid out in a
batch when the round fills. Originally a modern rewrite of the old PHP Devcoin
faucet, it now serves **any bitcoin-core-compatible altcoin** — point it at
Devcoin, Litecoin, Dogecoin, or anything speaking the core JSON-RPC protocol.

Built with **Node.js + TypeScript + Fastify + MySQL 8** with the old PHP
version's security problems engineered out:

- parameterised SQL everywhere, input validated by JSON schema + wallet daemon,
- no more "admin = IP allowlist": the admin panel uses a password + an
  httpOnly SameSite=Strict session cookie (CSRF/origin checks included),
- duplicate claims prevented by database unique indexes, not racy app checks,
- `X-Forwarded-For` only trusted from explicit proxy CIDRs (no spoofing),
- the old BitcoinTalk.org scraping & signature-bonus are gone,
- claims and round settlement share one lock: a claim can never land in a
  round that is being paid out at the same moment.

| | |
|---|---|
| Frontend | plain HTML/CSS/JS, zero front-end dependencies, CSP headers |
| Backend | Fastify 5, mysql2, reCAPTCHA v3 server verification |
| Money | integer smallest-units internally, `sendmany` batch payouts via coin daemon |
| Deploy | Docker compose; optional nginx-proxy override for TLS |

## Serving a different coin

Everything coin-specific is configuration. Change these in `.env` and restart:

```bash
COIN_NAME=Dogecoin
COIN_TICKER=DOGE
COIN_DECIMALS=8
COIN_RPC_URL=http://127.0.0.1:22555   # daemon rpc port
COIN_RPC_USER=...
COIN_RPC_PASSWORD=...
COIN_BALANCE_MODE=label                # or account / none (see .env.example)
DONATION_ADDRESS=<your donation address>
DONATION_LABEL=FaucetDonations         # label/account the daemon tracks
```

Requirements for the daemon (all bitcoin-core compatible):

- `validateaddress` — authoritative address check,
- `getreceivedbylabel` (label mode) **or** `getreceivedbyaccount` (account
  mode, older forks) — donation balance,
- `sendmany "" {address: amount}` — batch payouts,
- `getblockchaininfo` / `getnetworkinfo` / `listtransactions` — dashboard
  stats (these are optional; if a call fails the page degrades gracefully).

The faucet pays from the **wallet the daemon has loaded** — that wallet must
hold the donation funds and be unlocked.

## Quick start (Docker)

```bash
cp .env.example .env
# ... edit .env: COIN_*, DB_PASSWORD, RECAPTCHA_*, ADMIN_PASSWORD, SESSION_SECRET, DONATION_ADDRESS

docker compose up -d --build
```

The MySQL container auto-runs `migrations/init/` on first boot — it creates the
database, the `faucet` app user and seeds round #1. There is nothing else to
migrate in the Docker path.

Open `http://127.0.0.1:8080/` to claim and `http://127.0.0.1:8080/admin` to
manage.

## Local development (no Docker for the app)

Requirements: Node ≥ 20 and a MySQL 8 server.

```bash
npm install
# create the database/user and seed round #1
# (run against your MySQL as a user with DDL rights):
DB_USER=root DB_PASSWORD=<rootpw> npm run db:migrate
# or apply migrations/init/*.sh + migrations/schema.sql manually

cp .env.example .env   # fill in DB_* etc.
npm run dev            # tsx watch
```

Production build: `npm run build && npm start`.

## Production behind nginx-proxy (jwilder / letsencrypt)

```bash
docker network inspect nginx-proxy_default >/dev/null || docker network create nginx-proxy_default
docker compose -f compose.yml -f compose.prod.yml up -d --build
```

Set in `.env`:

```
VIRTUAL_HOST=faucet.example.com
LETSENCRYPT_EMAIL=you@example.com
# The docker bridge network(s) your proxy containers live on:
TRUSTED_PROXY_CIDRS=172.16.0.0/12,172.18.0.0/16
```

`TRUSTED_PROXY_CIDRS` lists **your own** proxy networks only. Requests that do
not come from those networks have any `X-Forwarded-For` ignored, so remote
visitors can never forge the client IP the faucet logs and de-duplicates.

## How it works

1. A visitor submits a receiving address.
2. The server verifies the reCAPTCHA v3 token (fail-closed), validates the
   address charset locally and asks the daemon `validateaddress`, then stores
   one row in `claims` for the current round.
3. `claims` is unique per `(round, ip)` and `(round, address)` — enforced by
   the database, so double-submits and races are impossible.
4. When the number of claims reaches `ROUND_SIZE` the settlement engine runs
   (serialised by an in-process mutex + `SELECT ... FOR UPDATE`):
   - reads the live donation balance,
   - if it covers `claims × singlepay` (+ optional fee reserve) it calls
     `sendmany`, records the `txid` in `payouts`, marks the round `paid` and
     opens the next round;
   - if not, the round simply stays open until enough donations arrive.
5. Every claim and payout is visible in the admin panel.

`rounds`, `claims`, `payouts` — that is the whole database. "Total paid out" is
`SUM(payouts)`, "total submissions" is `COUNT(claims)`, no manual counters.

### Money convention

Internally every amount is an **integer in the smallest unit** (sat, or
whatever `10^COIN_DECIMALS` is) — no floating point money. `payouts.amount_dvc`
stores the batch total in smallest units (the column name is legacy), while
`rounds.singlepay` stores an amount in whole coins.

## Admin panel

`/admin` — sign in with `ADMIN_USERNAME` / `ADMIN_PASSWORD` from `.env`.

| Action | Purpose |
|---|---|
| Set singlepay | payout per claim for the current round (also inherited by the next rounds) |
| Set round # | change the displayed round number |
| Delete all claims | drop the current round's claims (admin reset) |
| Try settle now | force a settlement attempt regardless of fill level |

The panel also shows live round statistics, claims of the current round,
settled-round history and the wallet's recent transactions.

## Security notes

- **Session cookie**: httpOnly + SameSite=Strict + Secure when served over
  HTTPS; sessions live in memory (single-instance) with a TTL.
- **Admin writes** require the session cookie **and** pass an Origin/Host check.
- **Login** is rate-limited (10/min) with a constant-time credential compare.
- **Claims** are rate-limited per real client IP (20/min).
- **reCAPTCHA** verification fails closed; optionally pin `RECAPTCHA_ALLOWED_HOSTNAMES`.
- The app runs as an unprivileged user (`node`) in the container.
- No front-end CDN dependencies; CSP is applied per page.

## Repository layout

```
src/
  config.ts     env parsing + fail-fast validation (coin-agnostic)
  db.ts         mysql connection pool
  rpc.ts        typed bitcoin-core JSON-RPC client (smallest-units internally)
  ip.ts         safe client-IP extraction (trusted proxies only)
  recaptcha.ts  reCAPTCHA v3 server verification (fail-closed)
  claims.ts     claim lifecycle (validate, insert, de-dup)
  settle.ts     round settlement engine (mutex + FOR UPDATE)
  stats.ts      cached public/admin statistics
  session.ts    admin session store
  http.ts       routes, security headers, auth
  server.ts     entrypoint
public/         static pages (index + admin) with vanilla JS
migrations/     schema.sql + docker-init scripts
scripts/        migrate.ts (manual/CLI migration path), smoke.mjs (no-DB smoke test)
```

## Smoke test (no database needed)

```bash
npm run build
node scripts/smoke.mjs    # starts a mock coin daemon + the compiled app
```

## License

MIT — see [LICENSE](LICENSE).
