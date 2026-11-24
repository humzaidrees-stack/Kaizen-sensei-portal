import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, makeClass } from './helpers.js';
import { closePool, prepare } from '../src/db.js';
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

    const published = await api(`/api/admin/schedule-drafts/${built.data.draft.id}/publish`, {
      method: 'POST', token: manager.cookie, body: {},
    });
    assert.equal(published.status, 200);
    assert.equal(published.data.published, false);
    assert.equal(published.data.writes, false);
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
});
