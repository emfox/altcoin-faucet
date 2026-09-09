import mysql from 'mysql2/promise';
import type { AppConfig } from './config.js';

let pool: mysql.Pool | null = null;

export function getPool(cfg: AppConfig): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: cfg.db.host,
      port: cfg.db.port,
      user: cfg.db.user,
      password: cfg.db.password,
      database: cfg.db.database,
      connectionLimit: cfg.db.poolSize,
      charset: 'utf8mb4',
      decimalNumbers: false,
      timezone: 'Z',
      waitForConnections: true,
      enableKeepAlive: true,
    });
  }
  return pool;
}

/** Returns the connection if the DB answers a trivial query, otherwise null. */
export async function pingDb(cfg: AppConfig): Promise<boolean> {
  try {
    const p = getPool(cfg);
    await p.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
