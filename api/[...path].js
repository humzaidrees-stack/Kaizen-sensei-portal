import { handle } from '../src/server.js';

export const config = { runtime: 'nodejs', maxDuration: 30 };

export default function handler(req, res) {
  return handle(req, res);
}
