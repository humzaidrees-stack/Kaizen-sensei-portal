// Demo data: the real roster, the November weekly template, and the November
// availability form. Wipes scheduling tables first. Logins go to data/DEMO_LOGINS.txt.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/env.js';

loadEnv();

if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SEED_RESET !== '1') {
  console.error('Refusing to wipe the database when NODE_ENV=production. Set ALLOW_SEED_RESET=1 to override.');
  process.exit(1);
}

const { migrate } = await import('./migrate.js');
await migrate();

const { prepare, closePool, setSetting } = await import('../src/db.js');
const { hashPin, newPin } = await import('../src/auth.js');
const { todayLocal, addDays, dowOf, toMin, reconcile } = await import('../src/logic.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
mkdirSync(dataDir, { recursive: true });

await prepare(`TRUNCATE alerts, claims, shifts, classes, unavailability, availability, sessions, login_attempts, instructors, settings RESTART IDENTITY CASCADE`).run();

const roster = [
  ['Charmaine Al Mulaifi', 'Charmaine'],
  ['Christina Sagawe', 'Christina'],
  ['Claudia Guerra Cafoncelli', 'Claudia'],
  ['Dezi Olle', 'Dezi'],
  ['Fiona Marie', 'Fiona'],
  ['Gaby Lee', 'Gaby'],
  ['Iona de Maudesley', 'Iona'],
  ['Jaime Cooke', 'Jaime'],
  ['Natacha Benbernou', 'Natacha'],
  ['Rena', 'Rena'],
  ['Venus Ng', 'Venus'],
];

function pinFor(code) {
  if (process.env.SEED_FIXED_PINS === '1') {
    if (code === 'ADMIN') return process.env.ADMIN_PIN || '246810';
    if (code === 'DESK') return process.env.DESK_PIN || '135790';
    const n = code.slice(2);
    return `${n}${n}`;
  }
  if (code === 'ADMIN' && process.env.ADMIN_PIN) return process.env.ADMIN_PIN;
  if (code === 'DESK' && process.env.DESK_PIN) return process.env.DESK_PIN;
  return newPin();
}

const logins = [];
const adminPin = pinFor('ADMIN');
await prepare("INSERT INTO instructors(code, name, pin_hash, role) VALUES('ADMIN', 'Studio manager', ?, 'manager')").run(hashPin(adminPin));
logins.push(['ADMIN', adminPin, 'Studio manager']);
const deskPin = pinFor('DESK');
await prepare("INSERT INTO instructors(code, name, pin_hash, role) VALUES('DESK', 'Front desk', ?, 'front_desk')").run(hashPin(deskPin));
logins.push(['DESK', deskPin, 'Front desk']);

const ids = {};
for (let i = 0; i < roster.length; i++) {
  const [name, short] = roster[i];
  const code = `KP${101 + i}`;
  const pin = pinFor(code);
  const row = await prepare('INSERT INTO instructors(code, name, mb_name, pin_hash, role) VALUES(?,?,?,?,?) RETURNING id')
    .get(code, name, name, hashPin(pin), 'sensei');
  ids[short] = row.id;
  logins.push([code, pin, name]);
}

function csv(file) {
  const p = path.join(root, 'sample-data', file);
  if (!existsSync(p)) return [];
  const [header, ...rows] = readFileSync(p, 'utf8').trim().split(/\r?\n/);
  const split = (line) => line.match(/("([^"]|"")*"|[^,]*)(,|$)/g).slice(0, -1)
    .map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"'));
  const keys = split(header);
  return rows.filter(Boolean).map((r) => Object.fromEntries(split(r).map((v, i) => [keys[i], v])));
}

const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const insA = prepare('INSERT INTO availability(instructor_id, dow, hour) VALUES(?,?,?) ON CONFLICT DO NOTHING');
for (const r of csv('Availability_Submissions_November_2026-10-26.csv')) {
  const id = ids[(r.name || '').split(' ')[0]];
  if (!id) continue;
  for (let dow = 0; dow < days.length; dow++) {
    const blocks = (r[`nov_${days[dow]}`] || '').split(';').map((s) => s.trim()).filter(Boolean);
    for (const b of blocks) {
      const h = Number(b.split('-')[0]);
      if (h >= 0 && h < 24) await insA.run(id, dow, h);
    }
  }
}

const mins = 50;
const tmpl = csv('november_schedule.csv');
const insC = prepare(`INSERT INTO classes(id, start, "end", name, staff_name, location, source)
  VALUES(?,?,?,?,?,?,'demo') ON CONFLICT(id) DO NOTHING`);
const today = todayLocal();
for (let d = 0; d < 42; d++) {
  const date = addDays(today, d);
  const dow = dowOf(date);
  for (const t of tmpl.filter((row) => days.indexOf(String(row.day || '').toLowerCase()) === dow)) {
    const endMin = toMin(t.time) + mins;
    const end = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
    await insC.run(`demo:${date}T${t.time}`, `${date}T${t.time}`, `${date}T${end}`, t.display || t.type, t.sensei, 'Kaizen Saadiyat');
  }
  if (dow === 5) {
    await insC.run(`demo:${date}T15:00`, `${date}T15:00`, `${date}T15:50`, 'Active Sculpt', 'Kaizen Sensei', 'Kaizen Saadiyat');
  }
}

const year = Number(today.slice(0, 4));
const leaves = [
  ['Christina', `${year}-12-06`, `${year}-12-21`, 'Leave'],
  ['Dezi', `${year}-12-21`, `${year}-12-27`, 'Leave'],
  ['Charmaine', `${year}-12-23`, `${year + 1}-01-01`, 'Leave'],
  ['Iona', `${year}-11-29`, `${year}-11-29`, ''],
  ['Iona', `${year}-12-27`, `${year}-12-27`, ''],
  ['Claudia', `${year}-12-24`, `${year}-12-24`, 'Christmas Eve'],
  ['Claudia', `${year}-12-31`, `${year}-12-31`, 'New Year\'s Eve'],
];
const insU = prepare('INSERT INTO unavailability(instructor_id, start_date, end_date, note) VALUES(?,?,?,?)');
for (const [name, start, end, note] of leaves) {
  if (end < today) continue;
  await insU.run(ids[name], start < today ? today : start, end, note || null);
}

await setSetting('schedule_source', 'demo');
await setSetting('last_sync', new Date().toISOString());
const result = await reconcile();

const lines = [
  'Demo logins for the local test copy only. Regenerated each time the seed runs.',
  'These are not production credentials.',
  '',
  ...logins.map(([code, pin, name]) => `${code.padEnd(7)} ${pin}  ${name}`),
  '',
];
writeFileSync(path.join(dataDir, 'DEMO_LOGINS.txt'), lines.join('\n'));
const classCount = await prepare('SELECT COUNT(*)::int AS n FROM classes').get();
console.log(`Seeded ${roster.length} sensei, front desk, and a manager. ${classCount.n} classes, ${result.opened} open shifts.`);
console.log('Logins written to data/DEMO_LOGINS.txt');
await closePool();
