import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, makeClass } from './helpers.js';
import { closePool, prepare } from '../src/db.js';
import { ensureFifteenthDrafts, publishDraft } from '../src/schedule-db.js';
import { createDevServer } from '../scripts/dev-server.js';

let server;
let base;

async function api(path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.cookie = token;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(base + path, { method, headers, body });
  const data = await res.json().catch(() => ({}));
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  return { status: res.status, data, cookie };
}

describe('schedule draft API', { concurrency: 1 }, () => {
  before(async () => {
    await resetDb();
    server = createDevServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closePool();
  });

  it('lets a manager build a draft, keeps new times out, and does not write to Mindbody', async () => {
    await resetDb();
    const ana = await makeUser({ code: 'KP801', name: 'Ana Teacher', pin: '1111', mbStaffId: '55' });
    const bea = await makeUser({ code: 'KP802', name: 'Bea Teacher', pin: '2222', mbStaffId: '56' });
    await makeUser({ code: 'DESK8', name: 'Front desk', role: 'front_desk', pin: '3333' });
    await makeUser({ code: 'ADMIN8', name: 'Studio manager', role: 'manager', pin: '4444' });
    await prepare("UPDATE instructors SET availability_confirmed_at='2026-11-01 00:00:00' WHERE id IN (?, ?)").run(ana.id, bea.id);
    for (const person of [ana, bea]) {
      for (let dow = 0; dow < 7; dow++) {
        for (let hour = 6; hour <= 20; hour++) {
          await prepare('INSERT INTO availability(instructor_id, dow, hour) VALUES(?,?,?)').run(person.id, dow, hour);
        }
      }
    }
    for (const date of ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30']) {
      await makeClass({
        id: `nov-${date}`, start: `${date}T08:00`, end: `${date}T09:00`,
        name: 'Core Power', staffName: 'Ana Teacher', staffId: '55', location: 'Kaizen Pilates',
      });
    }
    await makeClass({
      id: 'dec-one', start: '2026-12-07T08:00', end: '2026-12-07T09:00',
      name: 'Core Power', staffName: 'Kaizen Sensei', location: 'Kaizen Pilates',
    });
    await makeClass({
      id: 'dec-extra', start: '2026-12-01T11:00', end: '2026-12-01T12:00',
      name: 'Workshop', staffName: 'Bea Teacher', staffId: '56', location: 'Kaizen Pilates',
    });

    const desk = await api('/api/login', { method: 'POST', body: { code: 'DESK8', pin: '3333' } });
    const denied = await api('/api/admin/schedule-drafts?month=2026-12', { token: desk.cookie });
    assert.equal(denied.status, 403);

    const manager = await api('/api/login', { method: 'POST', body: { code: 'ADMIN8', pin: '4444' } });
    const built = await api('/api/admin/schedule-drafts', {
      method: 'POST', token: manager.cookie, body: { month: '2026-12', location: 'Kaizen Pilates' },
    });
    assert.equal(built.status, 200);
    const slots = built.data.draft.slots;
    const generated = slots.filter((s) => s.kind !== 'extra' && s.kind !== 'added');
    assert.equal(generated.every((s) => s.start.endsWith('T08:00')), true);
    assert.equal(generated.some((s) => s.kind === 'fill'), true);
    assert.equal(generated.some((s) => s.kind === 'missing'), true);
    assert.equal(slots.some((s) => s.kind === 'extra' && s.name === 'Workshop'), true);
    assert.equal(built.data.publish.writes, false);
    assert.equal(built.data.publish.message, 'Review only, publishing to Mindbody is off');

    const seen = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('mindbodyonline.com')) seen.push(String(url));
      return originalFetch(url, init);
    };
    let published;
    try {
      published = await api(`/api/admin/schedule-drafts/${built.data.draft.id}/publish`, {
        method: 'POST', token: manager.cookie, body: { confirm: true },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(published.status, 200);
    assert.equal(published.data.published, false);
    assert.equal(published.data.writes, false);
    assert.equal(seen.length, 0);
    const still = await prepare("SELECT staff_name FROM classes WHERE id='dec-one'").get();
    assert.equal(still.staff_name, 'Kaizen Sensei');
    assert.equal(published.data.diff.creates.length > 0, true);

    const added = await api(`/api/admin/schedule-drafts/${built.data.draft.id}/slots`, {
      method: 'POST', token: manager.cookie,
      body: { date: '2026-12-03', start: '07:00', end: '08:00', name: 'Gentle Flow' },
    });
    assert.equal(added.status, 200);
    const extraTime = added.data.draft.slots.find((s) => s.kind === 'added');
    assert.equal(extraTime.start, '2026-12-03T07:00');
    assert.equal(generated.some((s) => s.start.endsWith('T07:00')), false);
  });

  it('applies one sensei to every date of a weekly class', async () => {
    await resetDb();
    const ana = await makeUser({ code: 'KP901', name: 'Ana Teacher', pin: '1111', mbStaffId: '91' });
    await makeUser({ code: 'ADMIN9', name: 'Studio manager', role: 'manager', pin: '9999' });
    await prepare("UPDATE instructors SET availability_confirmed_at='2026-11-01 00:00:00' WHERE id=?").run(ana.id);
    for (let hour = 6; hour <= 20; hour++) {
      await prepare('INSERT INTO availability(instructor_id, dow, hour) VALUES(?,?,?)').run(ana.id, 0, hour);
    }
    const draft = await prepare(`INSERT INTO schedule_drafts(location, target_start, target_end, pattern_start, pattern_end, source)
      VALUES('Kaizen Pilates','2026-12-01','2026-12-31','2026-11-01','2026-11-30','manual') RETURNING id`).get();
    for (const date of ['2026-12-07', '2026-12-14']) {
      await prepare(`INSERT INTO schedule_draft_slots(draft_id, slot_date, start, "end", name, location, kind, reason, eligible_ids)
        VALUES(?,?,?,?,?,'Kaizen Pilates','fill','Open','[]')`).run(draft.id, date, `${date}T08:00`, `${date}T09:00`, 'Core Power');
    }
    const manager = await api('/api/login', { method: 'POST', body: { code: 'ADMIN9', pin: '9999' } });
    const applied = await api(`/api/admin/schedule-drafts/${draft.id}/template`, {
      method: 'PUT', token: manager.cookie,
      body: { dow: 0, time: '08:00', end: '09:00', name: 'Core Power', instructor_id: ana.id },
    });
    assert.equal(applied.status, 200);
    assert.equal(applied.data.kept, 2);
    const monday = applied.data.draft.week.rows.find((row) => row.time === '08:00' && row.weekday === 'Mon');
    assert.equal(monday.total, 2);
    assert.equal(monday.filled, 2);
    assert.equal(monday.senseiId, ana.id);
    assert.equal(applied.data.draft.week.unfilled, 0);
  });

  it('publishes only a changed teacher on the production host, and skips a match', async () => {
    await resetDb();
    const ana = await makeUser({ code: 'KP911', name: 'Ana Teacher', pin: '1111', mbStaffId: '91' });
    const bea = await makeUser({ code: 'KP912', name: 'Bea Teacher', pin: '2222', mbStaffId: '92' });
    await prepare("UPDATE instructors SET availability_confirmed_at='2026-11-01 00:00:00' WHERE id IN (?, ?)").run(ana.id, bea.id);
    const draft = await prepare(`INSERT INTO schedule_drafts(location, target_start, target_end, pattern_start, pattern_end, source)
      VALUES('Kaizen Pilates','2026-12-01','2026-12-31','2026-11-01','2026-11-30','manual') RETURNING id`).get();
    const insert = prepare(`INSERT INTO schedule_draft_slots(
      draft_id, slot_date, start, "end", name, location, class_id, current_staff_id, current_staff_name,
      proposed_instructor_id, reason, kind, eligible_ids
    ) VALUES(?,?,?,?,?,'Kaizen Pilates',?,?,?,?,?,'fill','[]')`);
    await insert.run(draft.id, '2026-12-07', '2026-12-07T08:00', '2026-12-07T09:00', 'Core Power', '701', '1', 'Kaizen Sensei', ana.id, 'Change');
    await insert.run(draft.id, '2026-12-08', '2026-12-08T08:00', '2026-12-08T09:00', 'Core Power', '702', '92', 'Bea Teacher', bea.id, 'Same');
    await insert.run(draft.id, '2026-12-09', '2026-12-09T08:00', '2026-12-09T09:00', 'Core Power', '703', '1', 'Kaizen Sensei', null, 'Open');
    await insert.run(draft.id, '2026-12-10', '2026-12-10T08:00', '2026-12-10T09:00', 'Gentle Flow', null, null, null, ana.id, 'Missing');
    await prepare(`UPDATE schedule_draft_slots SET kind='missing' WHERE class_id IS NULL AND draft_id=?`).run(draft.id);
    await prepare(`INSERT INTO schedule_draft_slots(
      draft_id, slot_date, start, "end", name, location, class_id, current_staff_name, reason, kind, removed, eligible_ids
    ) VALUES(?,?,?,?,?,'Kaizen Pilates','704','Ana Teacher','Remove','fill',TRUE,'[]')`).run(
      draft.id, '2026-12-11', '2026-12-11T08:00', '2026-12-11T09:00', 'Core Power',
    );
    const row = await prepare('SELECT * FROM schedule_drafts WHERE id=?').get(draft.id);
    process.env.MB_API_KEY = 'key';
    process.env.MB_SITE_ID = '123';
    process.env.MB_USERNAME = 'svc';
    process.env.MB_PASSWORD = 'pw';
    const calls = [];
    let posted = false;
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (!u.includes('mindbodyonline.com')) return original(url, init);
      calls.push({ url: u, body: init?.body ? JSON.parse(init.body) : null });
      if (u.includes('/usertoken/issue')) return { ok: true, text: async () => JSON.stringify({ AccessToken: 'staff-token' }) };
      if (u.includes('/class/classes')) {
        const id = new URL(u).searchParams.get('ClassIds');
        const staff = id === '701'
          ? (posted ? { Id: 91, DisplayName: 'Ana Teacher' } : { Id: 1, DisplayName: 'Kaizen Sensei' })
          : { Id: 91, DisplayName: 'Ana Teacher' };
        return { ok: true, text: async () => JSON.stringify({ Classes: [{ Id: Number(id), Staff: staff, Clients: [{ Email: 'hidden@example.com', Name: 'Client Name' }] }] }) };
      }
      if (u.includes('/class/substituteclassteacher')) {
        posted = true;
        return { ok: true, text: async () => JSON.stringify({ ClassId: 701 }) };
      }
      if (u.includes('addclassschedule') || u.includes('cancelsingleclass')) {
        return { ok: false, status: 500, text: async () => 'should not be called' };
      }
      return { ok: false, status: 500, text: async () => 'nope' };
    };
    try {
      const held = await publishDraft(row, { actorId: ana.id, host: 'sensei.kaizenpilates.ae', env: 'production', confirm: false });
      assert.equal(held.needsConfirm, true);
      assert.equal(held.published, false);
      assert.equal(calls.length, 0);
      assert.equal(held.counts.unfilled, 1);
      assert.equal(held.counts.creates, 1);
      assert.equal(held.counts.cancels, 1);

      const preview = await publishDraft(row, { actorId: ana.id, host: 'sensei.kaizenpilates.ae', env: 'preview', confirm: true });
      assert.equal(preview.writes, false);
      assert.equal(preview.message, 'Review only, publishing to Mindbody is off');
      assert.equal(calls.length, 0);

      const done = await publishDraft(row, { actorId: ana.id, host: 'sensei.kaizenpilates.ae', env: 'production', confirm: true });
      assert.equal(done.published, true);
      assert.equal(done.sent.length, 1);
      assert.equal(done.sent[0].classId, '701');
      assert.equal(done.skipped.length, 1);
      assert.equal(done.failed.length, 0);
      const writes = calls.filter((call) => call.url.includes('substituteclassteacher'));
      assert.equal(writes.length, 1);
      assert.equal(writes[0].body.ClassId, 701);
      assert.equal(writes[0].body.StaffId, 91);
      assert.equal(writes[0].body.SendClientEmail, false);
      assert.equal(writes[0].body.SendOriginalTeacherEmail, false);
      assert.equal(writes[0].body.SendSubstituteTeacherEmail, false);
      assert.equal(calls.some((call) => call.url.includes('addclassschedule') || call.url.includes('cancelsingleclass')), false);
      const logs = await prepare("SELECT value FROM settings WHERE key LIKE 'schedule_publish_log:%'").all();
      assert.equal(logs.length >= 2, true);
      assert.equal(logs.some((log) => /hidden@example.com|Client Name/.test(log.value)), false);

      calls.length = 0;
      const again = await publishDraft(row, { actorId: ana.id, host: 'sensei.kaizenpilates.ae', env: 'production', confirm: true });
      assert.equal(again.sent.length, 0);
      assert.equal(again.skipped.some((row) => row.classId === '701' && row.reason === 'live'), true);
      assert.equal(calls.some((call) => call.url.includes('substituteclassteacher')), false);
    } finally {
      globalThis.fetch = original;
      delete process.env.MB_API_KEY;
      delete process.env.MB_SITE_ID;
      delete process.env.MB_USERNAME;
      delete process.env.MB_PASSWORD;
      const { clearTokenCache } = await import('../src/mindbody.js');
      clearTokenCache();
    }
  });

  it('does not build a fifteenth draft while auto-draft is off', async () => {
    delete process.env.SCHEDULE_AUTO_DRAFT;
    const before = await prepare('SELECT count(*)::int AS n FROM schedule_drafts').get();
    const monthly = await ensureFifteenthDrafts('2026-12-15');
    assert.deepEqual(monthly, { skipped: true, reason: 'auto_draft_off' });
    const after = await prepare('SELECT count(*)::int AS n FROM schedule_drafts').get();
    assert.equal(after.n, before.n);
  });
});
