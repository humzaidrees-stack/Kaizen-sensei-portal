// Filesystem route for the daily Vercel cron and the GitHub sync workflow.
// A concrete file is matched before rewrites, so /api/cron/sync cannot 404
// even if the catch-all stays limited to one segment.
import { handle } from '../../src/server.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

export default function handler(req, res) {
  return handle(req, res);
}
