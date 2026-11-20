import { timingSafeEqual } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || '';
  }
}

export const bad = (msg) => { throw new HttpError(400, msg); };

export function send(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

export async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2e6) throw new HttpError(413, 'Too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if ((req.headers['content-type'] || '').includes('json')) {
    try { return text ? JSON.parse(text) : {}; } catch { bad('Invalid JSON'); }
  }
  return text;
}

export function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (!k) continue;
    out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
export const isTime = (s) => /^\d{2}:\d{2}$/.test(s || '');

// Vercel's Other preset registers api/[...path].js for one segment only.
// Nested paths are rewritten to /api/router?path=<rest>. Rebuild the public URL
// so the router still matches /api/cron/sync, /api/my/overview, and so on.
const REWRITTEN_PATHS = new Set(['/api/router', '/api/[...path]']);

export function resolveRequestUrl(req) {
  const raw = req.url || '/';
  let url;
  try { url = new URL(raw, 'http://localhost'); }
  catch { return raw; }
  let pathname = url.pathname;
  try { pathname = decodeURIComponent(pathname); } catch { /* keep the raw pathname */ }
  if (!REWRITTEN_PATHS.has(pathname)) return raw;
  const splat = url.searchParams.getAll('path').flatMap((part) => part.split('/')).filter(Boolean);
  if (!splat.length) return raw;
  url.searchParams.delete('path');
  const query = url.searchParams.toString();
  return `/api/${splat.join('/')}${query ? `?${query}` : ''}`;
}

export function cronAuthorized(req) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return false;
  const header = req.headers.authorization || req.headers['x-cron-secret'] || '';
  const presented = /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '') : (
    req.headers['x-cron-secret'] ? String(req.headers['x-cron-secret']) : ''
  );
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  // Imported lazily so this file stays free of a cycle if tests stub crypto.
  return timingSafeEqual(a, b);
}
