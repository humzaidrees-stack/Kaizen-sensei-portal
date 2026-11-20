// Rewrite target for nested /api/* paths. The Other preset does not send
// /api/a/b to api/[...path].js, so vercel.json points those requests here.
import { handle } from '../src/server.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

export default function handler(req, res) {
  return handle(req, res);
}
