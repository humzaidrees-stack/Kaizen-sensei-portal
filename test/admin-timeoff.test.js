import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, makeClass } from './helpers.js';
import { closePool, prepare } from '../src/db.js';
import { addDays, todayLocal, reconcile } from '../src/logic.js';
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

describe('admin time off', { concurrency: 1 }, () => {
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

  it('lets the desk book leave, alerts like the sensei, and opens classes that arrive later', async () => {
    const gaby = await makeUser({ code: 'GABYL', name: 'Gaby Lee', pin: '1111', mbName: 'Gaby Lee' });
    const desk = await makeUser({ code: 'DESK', name: 'Front desk', role: 'front_desk', pin: '2222' });
    const start = addDays(todayLocal(), 1);
    const far = addDays(start, 40);
    await makeClass({ id: 'soon', start: `${start}T10:00`, end: `${start}T10:50`, name: 'Reformer', staffName: 'Gaby Lee' });

    const sensei = await api('/api/login', { method: 'POST', body: { code: 'GABYL', pin: '1111' } });
    const loginBefore = await prepare('SELECT last_login_at FROM instructors WHERE id=?').get(gaby.id);
    const denied = await api(`/api/admin/instructors/${gaby.id}/timeoff`, {
      method: 'POST', token: sensei.cookie, body: { start_date: start, end_date: far },
    });
    assert.equal(denied.status, 403);

    const deskIn = await api('/api/login', { method: 'POST', body: { code: 'DESK', pin: '2222' } });
    const booked = await api(`/api/admin/instructors/${gaby.id}/timeoff`, {
      method: 'POST',
      token: deskIn.cookie,
      body: { start_date: start, end_date: far, note: 'WhatsApp: travelling' },
    });
    assert.equal(booked.status, 200);
    assert.equal(booked.data.opened, 1);
    assert.equal(booked.data.entered_by, 'admin');
    const stored = await prepare('SELECT end_date, note, entered_by, entered_by_id FROM unavailability WHERE id=?').get(booked.data.id);
    assert.equal(stored.end_date, far);
    assert.equal(stored.note, 'WhatsApp: travelling');
    assert.equal(stored.entered_by, 'admin');
    assert.equal(stored.entered_by_id, desk.id);
    const alerts = await prepare('SELECT kind, body FROM alerts ORDER BY id').all();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].kind, 'timeoff');
    assert.match(alerts[0].body, /Gaby is away/);
    assert.match(alerts[0].body, /1 class needs cover/);

    const login = await prepare('SELECT last_login_at FROM instructors WHERE id=?').get(gaby.id);
    assert.equal(new Date(login.last_login_at).toISOString(), new Date(loginBefore.last_login_at).toISOString());
    const still = await api('/api/me', { token: sensei.cookie });
    assert.equal(still.status, 200);
    assert.equal(still.data.user.id, gaby.id);

    const list = await api(`/api/admin/instructors/${gaby.id}/timeoff`, { token: deskIn.cookie });
    assert.equal(list.data.timeoff.length, 1);
    assert.equal(list.data.timeoff[0].end_date, far);
    assert.equal(list.data.timeoff[0].entered_by_name, 'Front desk');

    await makeClass({ id: 'later', start: `${far}T09:00`, end: `${far}T09:50`, name: 'Mat', staffName: 'Gaby Lee' });
    const synced = await reconcile();
    assert.equal(synced.opened, 1);
    const later = await prepare("SELECT status, reason FROM shifts WHERE class_id='later'").get();
    assert.equal(later.status, 'open');
    assert.equal(later.reason, 'unavailable');
    await prepare("UPDATE shifts SET status='filled' WHERE class_id='soon'").run();

    const removed = await api(`/api/admin/timeoff/${booked.data.id}`, { method: 'DELETE', token: deskIn.cookie });
    assert.equal(removed.status, 200);
    assert.equal(removed.data.ok, true);
    assert.equal((await prepare("SELECT status FROM shifts WHERE class_id='soon'").get()).status, 'filled');
    assert.equal((await prepare("SELECT status FROM shifts WHERE class_id='later'").get()).status, 'closed');
    assert.equal((await prepare('SELECT COUNT(*)::int AS n FROM unavailability').get()).n, 0);
  });

  it('opens the shifts without an alert when notify is false', async () => {
    const gaby = await makeUser({ code: 'GABYL', name: 'Gaby Lee', pin: '1111', mbName: 'Gaby Lee' });
    await makeUser({ code: 'ADMIN', name: 'Studio manager', role: 'manager', pin: '9999' });
    const start = addDays(todayLocal(), 2);
    await makeClass({ id: 'quiet', start: `${start}T18:00`, end: `${start}T18:50`, name: 'Sculpt', staffName: 'Gaby Lee' });
    const admin = await api('/api/login', { method: 'POST', body: { code: 'ADMIN', pin: '9999' } });
    const booked = await api(`/api/admin/instructors/${gaby.id}/timeoff`, {
      method: 'POST',
      token: admin.cookie,
      body: { start_date: start, end_date: start, notify: false },
    });
    assert.equal(booked.status, 200);
    assert.equal(booked.data.opened, 1);
    assert.equal(booked.data.entered_by, 'admin');
    assert.equal((await prepare('SELECT COUNT(*)::int AS n FROM alerts').get()).n, 0);
    const shift = await prepare("SELECT status, reason FROM shifts WHERE class_id='quiet'").get();
    assert.equal(shift.status, 'open');
    assert.equal(shift.reason, 'unavailable');
  });
});
