import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser } from './helpers.js';
import { closePool, prepare } from '../src/db.js';
import { nextCode, pinFromPhone } from '../src/auth.js';
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

describe('login IDs and phone PINs', { concurrency: 1 }, () => {
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

  it('builds a name login and length-4 PIN from a phone', async () => {
    assert.equal(pinFromPhone('+971 50 123 4567'), '4567');
    assert.equal(pinFromPhone('12-3'), null);
    assert.equal(await nextCode('Gaby Lee'), 'GABYL');
    assert.equal(await nextCode('Natacha Benbernou'), 'NATACHAB');
    assert.equal(await nextCode('Dézi Olle'), 'DEZIO');
    await makeUser({ code: 'GABYL', name: 'Taken', pin: '1111' });
    assert.equal(await nextCode('Gaby Lee'), 'GABYLE');
  });

  it('sets PINs from Mindbody phones without returning the numbers', async () => {
    const linked = await makeUser({ code: 'GABYL', name: 'Gaby Lee', pin: '1111', mbStaffId: '77' });
    const noPhone = await makeUser({ code: 'VENUSN', name: 'Venus Ng', pin: '1111', mbStaffId: '99' });
    const unlinked = await makeUser({ code: 'RENAR', name: 'Rena', pin: '1111' });
    await makeUser({ code: 'OLD', name: 'Inactive', pin: '1111', mbStaffId: '77' });
    await prepare("UPDATE instructors SET active=FALSE WHERE code='OLD'").run();
    await makeUser({ code: 'ADMIN', name: 'Studio manager', role: 'manager', pin: '9999' });
    process.env.MB_API_KEY = 'key';
    process.env.MB_SITE_ID = '1';
    const original = globalThis.fetch;
    let staffCalls = 0;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (!u.includes('mindbodyonline.com')) return original(url, init);
      staffCalls += 1;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          StaffMembers: [
            { Id: 77, FirstName: 'Gaby', LastName: 'Lee', MobilePhone: '', HomePhone: '0501234567', WorkPhone: '999' },
            { Id: 88, FirstName: 'Natacha', LastName: 'Benbernou', MobilePhone: '+971501110000' },
            { Id: 99, FirstName: 'Venus', LastName: 'Ng' },
          ],
          PaginationResponse: { TotalResults: 3 },
        }),
      };
    };
    try {
      const admin = await api('/api/login', { method: 'POST', body: { code: 'ADMIN', pin: '9999' } });
      const staff = await api('/api/admin/mb-staff', { token: admin.cookie });
      const raw = JSON.stringify(staff.data);
      assert.equal(raw.includes('0501234567'), false);
      assert.equal(raw.includes('MobilePhone'), false);
      assert.equal(raw.includes('971501110000'), false);

      const missing = await api(`/api/admin/instructors/${unlinked.id}/reset-pin`, {
        method: 'POST', token: admin.cookie, body: { from: 'phone' },
      });
      assert.equal(missing.status, 422);
      assert.equal(missing.data.code, 'no_phone');
      assert.equal(missing.data.error, 'No phone number on file in Mindbody');

      const one = await api(`/api/admin/instructors/${linked.id}/reset-pin`, {
        method: 'POST', token: admin.cookie, body: { from: 'phone' },
      });
      assert.equal(one.status, 200);
      assert.equal(one.data.pin, '4567');
      assert.equal(one.data.source, 'phone');

      const typed = await api(`/api/admin/instructors/${noPhone.id}/reset-pin`, {
        method: 'POST', token: admin.cookie, body: { phone: '+971 50 999 0001' },
      });
      assert.equal(typed.status, 200);
      assert.equal(typed.data.pin, '0001');
      assert.equal(JSON.stringify(typed.data).includes('999'), false);

      staffCalls = 0;
      const batch = await api('/api/admin/pins-from-phone', { method: 'POST', token: admin.cookie });
      assert.equal(batch.status, 200);
      assert.equal(staffCalls, 1);
      const byCode = Object.fromEntries(batch.data.results.map((r) => [r.code, r]));
      assert.equal(byCode.GABYL.status, 'set');
      assert.equal(byCode.GABYL.pin, '4567');
      assert.equal(byCode.VENUSN.status, 'no_phone');
      assert.equal(byCode.VENUSN.pin, null);
      assert.equal(byCode.RENAR.status, 'no_mb_link');
      assert.equal(byCode.OLD, undefined);
      assert.equal(JSON.stringify(batch.data).includes('0501234567'), false);

      const signed = await api('/api/login', { method: 'POST', body: { code: 'GABYL', pin: '4567' } });
      assert.equal(signed.data.user.must_change_pin, true);
      const changed = await api('/api/my/pin', {
        method: 'PUT', token: signed.cookie, body: { current: '4567', next: '2468' },
      });
      assert.equal(changed.status, 200);
      const me = await api('/api/me', { token: signed.cookie });
      assert.equal(me.data.user.must_change_pin, false);

      const random = await api(`/api/admin/instructors/${unlinked.id}/reset-pin`, { method: 'POST', token: admin.cookie });
      assert.equal(random.data.source, 'random');
      assert.match(random.data.pin, /^\d{6}$/);
    } finally {
      globalThis.fetch = original;
      delete process.env.MB_API_KEY;
      delete process.env.MB_SITE_ID;
    }
  });
});
