// Local server: static files from public/ plus the same API handler Vercel runs.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/env.js';

loadEnv();

const { handle } = await import('../src/server.js');

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

export function createDevServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return handle(req, res);
    const pathname = decodeURIComponent(url.pathname);
    const rel = pathname === '/' ? '/index.html' : pathname;
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    try {
      const data = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    } catch {
      if (path.extname(rel)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      const data = await readFile(path.join(PUBLIC, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT || 8791);
  const server = createDevServer();
  server.listen(port, () => {
    console.log(`Kaizen Sensei portal on http://localhost:${port}`);
  });
}
