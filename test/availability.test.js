import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser } from './helpers.js';
import { closePool } from '../src/db.js';
import { addDays, todayLocal, dowOf, fitsWeekly } from '../src/logic.js';
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

describe('desk pre-filled availability', { concurrency: 1 }, () => {
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

  it('lets the desk propose hours, the sensei confirm, and keeps the blocks usable as a hint', async () => {
    const sensei = await makeUser({ code: 'KP401', name: 'Christina Sagawe', pin: '1111' });
    await makeUser({ code: 'DESK', name: 'Grace', role: 'front_desk', pin: '2222' });
    const other = await makeUser({ code: 'KP402', name: 'Claudia Guerra Cafoncelli', pin: '3333' });
    const date = addDays(todayLocal(), 3);
    const dow = dowOf(date);

    const chris = await api('/api/login', { method: 'POST', body: { code: 'KP401', pin: '1111' } });
    const denied = await api(`/api/admin/instructors/${sensei.id}/availability`, { token: chris.cookie });
    assert.equal(denied.status, 403);

    const desk = await api('/api/login', { method: 'POST', body: { code: 'DESK', pin: '2222' } });
    const saved = await api(`/api/admin/instructors/${sensei.id}/availability`, {
      method: 'PUT', token: desk.cookie, body: { blocks: [[dow, 9], [dow, 10]] },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.status, 'proposed');
    assert.equal(saved.data.prefilled_by_name, 'Grace');
    assert.equal(saved.data.confirmed_at, null);
    assert.equal(saved.data.blocks.length, 2);

    const notSensei = await api(`/api/admin/instructors/${other.id}/availability`, { token: desk.cookie });
    assert.equal(notSensei.status, 200);

    const overview = await api('/api/my/overview', { token: chris.cookie });
    assert.equal(overview.data.availability_status.status, 'proposed');
    assert.equal(overview.data.availability_status.prefilled_by_name, 'Grace');
    assert.equal(await fitsWeekly(sensei.id, `${date}T09:00`, `${date}T10:50`), true);

    const board = await api('/api/admin/overview', { token: desk.cookie });
    const row = board.data.instructors.find((i) => i.id === sensei.id);
    assert.equal(row.availability_status, 'proposed');
    assert.equal(row.availability_prefilled_by_name, 'Grace');

    const confirmed = await api('/api/my/availability/confirm', { method: 'POST', token: chris.cookie });
    assert.equal(confirmed.status, 200);
    const after = await api(`/api/admin/instructors/${sensei.id}/availability`, { token: desk.cookie });
    assert.equal(after.data.status, 'confirmed');
    assert.ok(after.data.confirmed_at);

    const again = await api(`/api/admin/instructors/${sensei.id}/availability`, {
      method: 'PUT', token: desk.cookie, body: { blocks: [[dow, 18]] },
    });
    assert.equal(again.data.status, 'proposed');
    assert.equal(again.data.confirmed_at, null);

    const edited = await api('/api/my/availability', {
      method: 'PUT', token: chris.cookie, body: { blocks: [[dow, 18], [dow, 19]] },
    });
    assert.equal(edited.status, 200);
    const final = await api(`/api/admin/instructors/${sensei.id}/availability`, { token: desk.cookie });
    assert.equal(final.data.status, 'confirmed');
    assert.equal(final.data.blocks.length, 2);
    assert.equal(final.data.prefilled_by_name, 'Grace');
  });

  it('clears a proposal when the desk removes every hour', async () => {
    const sensei = await makeUser({ code: 'KP411', name: 'Venus Ng', pin: '1111' });
    await makeUser({ code: 'DESK', name: 'Grace', role: 'front_desk', pin: '2222' });
    const desk = await api('/api/login', { method: 'POST', body: { code: 'DESK', pin: '2222' } });
    await api(`/api/admin/instructors/${sensei.id}/availability`, {
      method: 'PUT', token: desk.cookie, body: { blocks: [[1, 8]] },
    });
    const cleared = await api(`/api/admin/instructors/${sensei.id}/availability`, {
      method: 'PUT', token: desk.cookie, body: { blocks: [] },
    });
    assert.equal(cleared.data.status, 'not_set');
    assert.equal(cleared.data.blocks.length, 0);
    assert.equal(cleared.data.prefilled_by_name, null);
  });
});
