import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser } from './helpers.js';
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

describe('last login', { concurrency: 1 }, () => {
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

  it('records a successful login for every role and leaves a failed one untouched', async () => {
    const sensei = await makeUser({ code: 'GABYL', name: 'Gaby Lee', pin: '1111' });
    const desk = await makeUser({ code: 'DESK', name: 'Front desk', role: 'front_desk', pin: '2222' });
    await makeUser({ code: 'ADMIN', name: 'Studio manager', role: 'manager', pin: '9999' });

    const wrong = await api('/api/login', { method: 'POST', body: { code: 'GABYL', pin: '0000' } });
    assert.equal(wrong.status, 401);
    const before = await prepare('SELECT last_login_at FROM instructors WHERE id=?').get(sensei.id);
    assert.equal(before.last_login_at, null);

    const ok = await api('/api/login', { method: 'POST', body: { code: 'GABYL', pin: '1111' } });
    assert.equal(ok.status, 200);
    assert.ok(ok.data.user.last_login_at);
    const stamped = await prepare('SELECT last_login_at FROM instructors WHERE id=?').get(sensei.id);
    assert.equal(new Date(stamped.last_login_at).toISOString(), ok.data.user.last_login_at);

    const again = await api('/api/login', { method: 'POST', body: { code: 'GABYL', pin: '0000' } });
    assert.equal(again.status, 401);
    const unchanged = await prepare('SELECT last_login_at FROM instructors WHERE id=?').get(sensei.id);
    assert.equal(new Date(unchanged.last_login_at).toISOString(), ok.data.user.last_login_at);

    const deskIn = await api('/api/login', { method: 'POST', body: { code: 'DESK', pin: '2222' } });
    assert.ok(deskIn.data.user.last_login_at);
    const deskRow = await prepare('SELECT last_login_at FROM instructors WHERE id=?').get(desk.id);
    assert.ok(deskRow.last_login_at);

    const admin = await api('/api/login', { method: 'POST', body: { code: 'ADMIN', pin: '9999' } });
    const board = await api('/api/admin/overview', { token: admin.cookie });
    const row = board.data.instructors.find((i) => i.id === sensei.id);
    assert.equal(row.last_login_at, ok.data.user.last_login_at);
    assert.equal(board.data.instructors.find((i) => i.code === 'DESK'), undefined);
  });
});
