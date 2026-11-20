// One sync at a time. The daily Vercel cron and the GitHub Actions job can overlap.
// The lock is session-scoped and held on a dedicated pooled connection, then unlocked
// on that same connection so it is not returned to the pool still locked.
import { getPool } from './db.js';

// Stable bigint. Fits in a JS safe integer and in Postgres bigint.
const SYNC_LOCK_ID = '7482910331';

export async function withSyncLock(fn) {
  const client = await getPool().connect();
  let locked = false;
  try {
    const res = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [SYNC_LOCK_ID]);
    const got = res.rows[0]?.locked;
    locked = got === true || got === 't';
    if (!locked) return { skipped: true, reason: 'sync_in_progress' };
    return await fn();
  } finally {
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock($1::bigint)', [SYNC_LOCK_ID]);
      client.release();
    } catch (err) {
      // A connection released while it still holds the lock would block every later sync.
      client.release(err);
    }
  }
}
