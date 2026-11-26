// Syntax-check the app, then migrate when DATABASE_URL is present (Vercel build).
import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/env.js';

loadEnv();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skip = new Set(['node_modules', '.git', 'data', '.vercel']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(root);
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Syntax OK (${files.length} files).`);

// Preview and production share one Neon database. A preview build must not migrate it.
// 006 was applied once, with approval, and is recorded in schema_migrations.
if (process.env.VERCEL_ENV === 'preview') {
  console.log('Preview build: skipped migrations so the shared production database is not changed.');
} else if (process.env.DATABASE_URL) {
  const result = spawnSync(process.execPath, [path.join(root, 'db/migrate.js')], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
} else {
  console.log('DATABASE_URL is not set; skipped migrations.');
}
