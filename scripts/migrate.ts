/**
 * One-shot migration runner.
 *
 * Creates the database + tables (idempotent) and seeds round #1 when the
 * rounds table is empty. Run it once with a database user that has DDL
 * rights, e.g.:
 *
 *   DB_PASSWORD=... npm run db:migrate
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { loadConfig } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const cfg = loadConfig();

  // Connect without a database first so we can CREATE DATABASE.
  const admin = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
    charset: 'utf8mb4',
    multipleStatements: true,
  });

  const sql = await readFile(path.join(here, 'schema.sql'), 'utf8');
  console.log('Executing schema.sql ...');
  await admin.query(sql);
  console.log('Schema ready.');

  const [[{ n }]] = (await admin.query(
    'SELECT COUNT(*) AS n FROM faucet.rounds',
  )) as mysql.RowDataPacket[][];

  if (n === 0) {
    const precision = Math.min(cfg.coin.decimals, 8);
    const singlepay = cfg.initialSinglepay.toFixed(precision);
    await admin.query('INSERT INTO faucet.rounds (round_no, singlepay) VALUES (1, ?)', [singlepay]);
    console.log(`Seeded round #1 with singlepay = ${singlepay} coins.`);
  } else {
    console.log(`Rounds table already has ${n} row(s); skipping seed.`);
  }

  await admin.end();
  console.log('Migration finished.');
}

main().catch((e) => {
  console.error('Migration failed:', e);
  process.exit(1);
});
