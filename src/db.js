// Postgres access. SQL in the app uses `?` placeholders; they are rewritten to $1, $2, …
// A transaction stores its client in AsyncLocalStorage so callers stay unaware of it.
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { poolConfig } from './pg-config.js';

const { Pool } = pg;
const storage = new AsyncLocalStorage();

export function getPool() {
  if (!globalThis.__kaizenPool) {
    const pool = new Pool(poolConfig());
    pool.on('error', (err) => console.error('Postgres pool error', err.message));
    globalThis.__kaizenPool = pool;
  }
  return globalThis.__kaizenPool;
}

export async function closePool() {
  const pool = globalThis.__kaizenPool;
  if (!pool) return;
  globalThis.__kaizenPool = null;
  await pool.end();
}

function toPg(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

export async function query(sql, params = []) {
  const client = storage.getStore() || getPool();
  return client.query(toPg(sql), params);
}

export function prepare(sql) {
  return {
    async all(...params) {
      const res = await query(sql, params);
      return res.rows;
    },
    async get(...params) {
      const res = await query(sql, params);
      return res.rows[0];
    },
    async run(...params) {
      const res = await query(sql, params);
      return {
        changes: res.rowCount,
        lastInsertRowid: res.rows[0]?.id ?? null,
        row: res.rows[0] || null,
      };
    },
  };
}

// Runs `fn` inside a transaction. Nested calls join the current one.
export async function transaction(fn) {
  if (storage.getStore()) return fn();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await storage.run(client, fn);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already aborted */ }
    throw err;
  } finally {
    client.release();
  }
}

const STAMP = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`;
export const sqlNow = () => STAMP;

export async function getSetting(key, fallback = null) {
  const row = await prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row?.value ?? fallback;
}

export async function setSetting(key, value) {
  await prepare(`INSERT INTO settings(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`).run(key, value == null ? null : String(value));
}
