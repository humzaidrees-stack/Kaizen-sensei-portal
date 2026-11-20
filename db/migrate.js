// Applies db/migrations/*.sql once, in filename order.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { poolConfig } from '../src/pg-config.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate(connectionString = process.env.DATABASE_URL) {
  const pool = new pg.Pool({ ...poolConfig(connectionString), max: 1 });
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const done = await client.query('SELECT 1 FROM schema_migrations WHERE id=$1', [file]);
      if (done.rowCount) continue;
      const sql = readFileSync(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(id) VALUES($1)', [file]);
        await client.query('COMMIT');
        console.log(`Applied ${file}`);
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  migrate().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
