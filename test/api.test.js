import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, makeClass } from './helpers.js';
import { closePool, prepare } from '../src/db.js';
import { addDays, todayLocal } from '../src/logic.js';
import { createDevServer } from '../scripts/dev-server.js';
import { withSyncLock } from '../src/sync-lock.js';

let server;
let base;

async function api(path, { method = 'GET', token, body, raw } = {}) {
  const headers = {};
  if (token) headers.cookie = token;
  if (body !== undefined) {
    if (typeof body === 'string') {
      headers['content-type'] = 'text/plain';
    } else {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(body);
    }
  }
  const res = await fetch(base + path, { method, headers, body });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  const setCookie = res.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  return { status: res.status, data, cookie, setCookie, text };
}

describe('API', { concurrency: 1 }, () => {
  before(async () => {
    await resetDb();
    server = createDevServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  beforeEach(async () => { await resetDb(); });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closePool();
  });

  it('logs in with a hashed PIN, sets an HttpOnly cookie, and locks after six failures', async () => {
    await makeUser({ code: 'KP301', name: 'Rena', pin: '4455' });
    const bad = await api('/api/login', { method: 'POST', body: { code: 'kp301', pin: '0000' } });
    assert.equal(bad.status, 401);
    for (let i = 0; i < 5; i++) {
      const again = await api('/api/login', { method: 'POST', body: { code: 'KP301', pin: 'nope' } });
      assert.equal(again.status, 401);
    }
    const locked = await api('/api/login', { method: 'POST', body: { code: 'KP301', pin: '4455' } });
    assert.equal(locked.status, 429);
    await prepare('DELETE FROM login_attempts').run();
    const ok = await api('/api/login', { method: 'POST', body: { code: 'KP301', pin: '4455' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.user.role, 'sensei');
    assert.match(ok.setCookie, /kp_s=/);
    assert.match(ok.setCookie, /HttpOnly/i);
    assert.match(ok.setCookie, /SameSite=Lax/i);
    const me = await api('/api/me', { token: ok.cookie });
    assert.equal(me.data.user.name, 'Rena');
    assert.equal(JSON.stringify(me.data).includes('pin_hash'), false);
  });

  it('refuses a sensei on desk routes and a desk login on another sensei\'s data', async () => {
    const a = await makeUser({ code: 'KP311', name: 'Christina Sagawe', pin: '1111' });
    const b = await makeUser({ code: 'KP312', name: 'Claudia Guerra Cafoncelli', pin: '2222' });
    await makeUser({ code: 'DESK', name: 'Front desk', role: 'front_desk', pin: '3333' });
    const date = addDays(todayLocal(), 4);
    await makeClass({ id: 'mine', start: `${date}T09:00`, end: `${date}T09:50`, name: 'Gentle Flow', staffName: 'Christina Sagawe' });
    await prepare('INSERT INTO availability(instructor_id, dow, hour) VALUES(?,?,?)').run(a.id, 0, 9);
    await prepare('INSERT INTO unavailability(instructor_id, start_date, end_date, note) VALUES(?,?,?,?)')
      .run(a.id, date, date, 'Private note');

    const sensei = await api('/api/login', { method: 'POST', body: { code: 'KP312', pin: '2222' } });
    const overview = await api('/api/my/overview', { token: sensei.cookie });
    assert.equal(overview.status, 200);
    assert.equal(overview.data.timeoff.length, 0);
    assert.equal(overview.data.availability.length, 0);
    assert.equal(overview.data.classes.length, 0);
    const steal = await api('/api/my/availability', { method: 'PUT', token: sensei.cookie, body: { blocks: [[0, 9]], instructor_id: a.id } });
    assert.equal(steal.status, 200);
    const aBlocks = await prepare('SELECT hour FROM availability WHERE instructor_id=?').all(a.id);
    const bBlocks = await prepare('SELECT hour FROM availability WHERE instructor_id=?').all(b.id);
    assert.deepEqual(aBlocks.map((r) => r.hour), [9]);
    assert.deepEqual(bBlocks.map((r) => r.hour), [9]);
    const removed = await api(`/api/my/timeoff/${1}`, { method: 'DELETE', token: sensei.cookie });
    assert.equal(removed.status, 200);
    const still = await prepare('SELECT note FROM unavailability WHERE instructor_id=?').get(a.id);
    assert.equal(still.note, 'Private note');
    const deskDenied = await api('/api/admin/overview', { token: sensei.cookie });
    assert.equal(deskDenied.status, 403);

    const desk = await api('/api/login', { method: 'POST', body: { code: 'DESK', pin: '3333' } });
    const deskHome = await api('/api/admin/overview', { token: desk.cookie });
    assert.equal(deskHome.status, 200);
    assert.equal(JSON.stringify(deskHome.data).includes('pin_hash'), false);
    assert.equal(deskHome.data.instructors[0].code, undefined);
    const noTeam = await api('/api/admin/instructors', { method: 'POST', token: desk.cookie, body: { name: 'New Person' } });
    assert.equal(noTeam.status, 403);
    const noSelf = await api('/api/my/overview', { token: desk.cookie });
    assert.equal(noSelf.status, 403);
  });

  it('books time off into an open shift, a claim, an approval, and the Mindbody fallback note', async () => {
    const christina = await makeUser({ code: 'KP321', name: 'Christina Sagawe', pin: '1111', mbName: 'Christina Sagawe' });
    const claudia = await makeUser({ code: 'KP322', name: 'Claudia Guerra Cafoncelli', pin: '2222' });
    await makeUser({ code: 'DESK', name: 'Front desk', role: 'front_desk', pin: '3333' });
    await makeUser({ code: 'ADMIN', name: 'Studio manager', role: 'manager', pin: '4444' });
    const date = addDays(todayLocal(), 6);
    await makeClass({ id: 'demo:cover', start: `${date}T17:00`, end: `${date}T17:50`, name: 'Power Surge', staffName: 'Christina' });
    await makeClass({ id: 'demo:keep', start: `${date}T09:00`, end: `${date}T09:50`, name: 'Gentle Flow', staffName: 'Christina Sagawe' });

    const chris = await api('/api/login', { method: 'POST', body: { code: 'KP321', pin: '1111' } });
    const off = await api('/api/my/timeoff', {
      method: 'POST',
      token: chris.cookie,
      body: { start_date: date, end_date: date, start_time: '16:00', end_time: '18:00', note: 'Appointment' },
    });
    assert.equal(off.status, 200);
    assert.equal(off.data.opened, 1);
    const alerts = await prepare("SELECT kind, body, status FROM alerts ORDER BY id").all();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].kind, 'timeoff');
    assert.match(alerts[0].body, /Christina is away/);
    assert.match(alerts[0].body, /1 class needs cover/);
    assert.ok(['queued', 'logged', 'sent'].includes(alerts[0].status));

    const own = await api('/api/shifts/1/claim', { method: 'POST', token: chris.cookie });
    assert.equal(own.status, 400);

    const clau = await api('/api/login', { method: 'POST', body: { code: 'KP322', pin: '2222' } });
    await makeClass({ id: 'clash', start: `${date}T17:00`, end: `${date}T17:50`, name: 'Core Power', staffName: 'Claudia' });
    const busy = await api('/api/shifts/1/claim', { method: 'POST', token: clau.cookie });
    assert.equal(busy.status, 400);
    await prepare("DELETE FROM classes WHERE id='clash'").run();
    const claimed = await api('/api/shifts/1/claim', { method: 'POST', token: clau.cookie });
    assert.equal(claimed.status, 200);
    const claimAlerts = await prepare("SELECT kind FROM alerts WHERE kind='claim'").all();
    assert.equal(claimAlerts.length, 1);

    const desk = await api('/api/login', { method: 'POST', body: { code: 'DESK', pin: '3333' } });
    const board = await api('/api/admin/overview', { token: desk.cookie });
    const shift = board.data.shifts.find((s) => s.name === 'Power Surge');
    assert.equal(shift.claims.filter((c) => c.status === 'pending').length, 1);
    const assigned = await api(`/api/admin/shifts/${shift.id}/assign`, {
      method: 'POST',
      token: desk.cookie,
      body: { instructor_id: claudia.id },
    });
    assert.equal(assigned.status, 200);
    assert.equal(assigned.data.mb_note, 'Update the instructor on this class in Mindbody.');
    const stored = await prepare('SELECT status, assigned_instructor_id, mb_note FROM shifts WHERE id=?').get(shift.id);
    assert.equal(stored.status, 'filled');
    assert.equal(stored.assigned_instructor_id, claudia.id);
    assert.equal(stored.mb_note, 'Update the instructor on this class in Mindbody.');

    const removed = await api('/api/my/timeoff/1', { method: 'DELETE', token: chris.cookie });
    assert.equal(removed.status, 200);
    const stillFilled = await prepare('SELECT status FROM shifts WHERE id=?').get(shift.id);
    assert.equal(stillFilled.status, 'filled');
    assert.equal(christina.id > 0, true);
  });

  it('writes the substitute to Mindbody when a service user is configured, and records the failure note', async () => {
    const cover = await makeUser({ code: 'KP331', name: 'Venus Ng', pin: '1111', mbStaffId: '77' });
    await makeUser({ code: 'ADMIN', name: 'Studio manager', role: 'manager', pin: '9999' });
    const date = addDays(todayLocal(), 3);
    await makeClass({ id: '4242', start: `${date}T15:00`, end: `${date}T15:50`, name: 'Active Sculpt', staffName: 'Kaizen Sensei', source: 'mindbody' });
    await prepare(`INSERT INTO shifts(class_id, auto, start, "end", name, reason, status) VALUES('4242', TRUE, ?, ?, 'Active Sculpt', 'sensei', 'open')`)
      .run(`${date}T15:00`, `${date}T15:50`);
    process.env.MB_API_KEY = 'key';
    process.env.MB_SITE_ID = '123';
    process.env.MB_USERNAME = 'svc';
    process.env.MB_PASSWORD = 'pw';
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (!u.includes('mindbodyonline.com')) return original(url, init);
      calls.push({ url: u, body: init?.body ? JSON.parse(init.body) : null, headers: init?.headers });
      if (u.includes('/usertoken/issue')) {
        return { ok: true, text: async () => JSON.stringify({ AccessToken: 'staff-token' }) };
      }
      if (u.includes('/class/substituteclassteacher')) {
        return { ok: true, text: async () => JSON.stringify({ ClassId: 4242 }) };
      }
      return { ok: false, status: 500, text: async () => 'nope' };
    };
    try {
      const admin = await api('/api/login', { method: 'POST', body: { code: 'ADMIN', pin: '9999' } });
      const ok = await api('/api/admin/shifts/1/assign', { method: 'POST', token: admin.cookie, body: { instructor_id: cover.id } });
      assert.equal(ok.status, 200);
      assert.match(ok.data.mb_note, /^Updated in Mindbody /);
      const write = calls.find((c) => c.url.includes('substituteclassteacher'));
      assert.equal(write.body.ClassId, 4242);
      assert.equal(write.body.StaffId, 77);
      assert.equal(write.headers.Authorization, 'staff-token');
      assert.equal(write.headers['Api-Key'], 'key');
      assert.equal(calls.some((c) => String(c.headers?.['Api-Key']) && c.url.startsWith('http://127.0.0.1')), false);

      globalThis.fetch = async (url, init) => {
        if (!String(url).includes('mindbodyonline.com')) return original(url, init);
        return { ok: false, status: 400, text: async () => JSON.stringify({ Error: { Message: 'Staff conflict' } }) };
      };
      await prepare("UPDATE shifts SET status='open', assigned_instructor_id=NULL, mb_note=NULL WHERE id=1").run();
      const { clearTokenCache } = await import('../src/mindbody.js');
      clearTokenCache();
      const failed = await api('/api/admin/shifts/1/assign', { method: 'POST', token: admin.cookie, body: { instructor_id: cover.id } });
      assert.equal(failed.status, 200);
      assert.match(failed.data.mb_note, /Mindbody update failed: Mindbody 400: Staff conflict/);
      assert.match(failed.data.mb_note, /Update the class by hand/);
    } finally {
      globalThis.fetch = original;
      delete process.env.MB_API_KEY;
      delete process.env.MB_SITE_ID;
      delete process.env.MB_USERNAME;
      delete process.env.MB_PASSWORD;
    }
  });

  it('imports a CSV, alerts once for a placeholder class, and protects the cron route', async () => {
    await makeUser({ code: 'ADMIN', name: 'Studio manager', role: 'manager', pin: '9999' });
    const date = addDays(todayLocal(), 2);
    const [y, m, d] = date.split('-');
    const csv = `date,start,class,instructor,location\n${d}/${m}/${y},15:00,Active Sculpt,Kaizen Sensei,Kaizen Saadiyat\n${date},09:00,Gentle Flow,Christina Sagawe,Kaizen Saadiyat\n`;
    const admin = await api('/api/login', { method: 'POST', body: { code: 'ADMIN', pin: '9999' } });
    const imported = await api('/api/admin/import', { method: 'POST', token: admin.cookie, body: csv });
    assert.equal(imported.status, 200);
    assert.equal(imported.data.classes, 2);
    assert.equal(imported.data.opened, 1);
    const senseiAlerts = await prepare("SELECT * FROM alerts WHERE kind='sensei'").all();
    assert.equal(senseiAlerts.length, 1);
    assert.match(senseiAlerts[0].body, /Active Sculpt has no instructor/);

    const denied = await api('/api/cron/sync');
    assert.equal(denied.status, 401);
    const previous = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    const noSecret = await api('/api/cron/sync', { token: 'Bearer test-cron-secret' });
    process.env.CRON_SECRET = previous;
    assert.equal(noSecret.status, 401);
    const ran = await fetch(`${base}/api/cron/sync`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
    assert.equal(ran.status, 200);
    const again = await prepare("SELECT COUNT(*)::int AS n FROM alerts WHERE kind='sensei'").get();
    assert.equal(again.n, 1);

    const bypassOnly = await fetch(`${base}/api/cron/sync`, { headers: { 'x-vercel-protection-bypass': 'bypass-token' } });
    assert.equal(bypassOnly.status, 401);
    let release;
    const started = new Promise((resolve) => { release = { go: null, mark: resolve }; });
    const held = withSyncLock(async () => {
      release.mark();
      await new Promise((resolve) => { release.go = resolve; });
    });
    await started;
    const overlap = await fetch(`${base}/api/cron/sync`, {
      headers: {
        authorization: `Bearer ${process.env.CRON_SECRET}`,
        'x-vercel-protection-bypass': 'bypass-token',
      },
    });
    const overlapBody = await overlap.json();
    release.go();
    await held;
    assert.equal(overlap.status, 200);
    assert.equal(overlapBody.skipped, true);
    assert.equal(overlapBody.reason, 'sync_in_progress');
    const after = await fetch(`${base}/api/cron/sync`, {
      headers: {
        authorization: `Bearer ${process.env.CRON_SECRET}`,
        'x-vercel-protection-bypass': 'bypass-token',
      },
    });
    const afterBody = await after.json();
    assert.equal(after.status, 200);
    assert.equal(afterBody.skipped, undefined);
    assert.ok(afterBody.sync);
    const stillOne = await prepare("SELECT COUNT(*)::int AS n FROM alerts WHERE kind='sensei'").get();
    assert.equal(stillOne.n, 1);
  });

  it('lets a manager create a sensei and blocks the browser from seeing Mindbody secrets', async () => {
    await makeUser({ code: 'ADMIN', name: 'Studio manager', role: 'manager', pin: '9999' });
    const admin = await api('/api/login', { method: 'POST', body: { code: 'ADMIN', pin: '9999' } });
    const created = await api('/api/admin/instructors', { method: 'POST', token: admin.cookie, body: { name: 'New Sensei', mb_name: 'New Sensei' } });
    assert.equal(created.status, 200);
    assert.equal(created.data.code, 'NEWS');
    assert.match(created.data.pin, /^\d{6}$/);
    const page = await fetch(`${base}/`);
    const html = await page.text();
    assert.match(html, /Kaizen Sensei/);
    assert.equal(html.includes('MB_API_KEY'), false);
    const js = await (await fetch(`${base}/app.js`)).text();
    assert.equal(js.includes('MB_API_KEY'), false);
    assert.equal(js.includes('WA_TOKEN'), false);
  });
});
