import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { resolveRequestUrl } from '../src/http.js';
import { handle } from '../src/server.js';
import { matchRoute } from '../src/routes.js';

// Every path the phone UI fetches. Nested ones 404'd on Vercel before the rewrite.
const FRONTEND_ROUTES = [
  ['POST', '/api/login'],
  ['POST', '/api/logout'],
  ['GET', '/api/me'],
  ['PUT', '/api/my/pin'],
  ['GET', '/api/my/overview'],
  ['PUT', '/api/my/availability'],
  ['POST', '/api/my/availability/confirm'],
  ['POST', '/api/my/timeoff'],
  ['DELETE', '/api/my/timeoff/4'],
  ['POST', '/api/shifts/4/claim'],
  ['DELETE', '/api/shifts/4/claim'],
  ['GET', '/api/admin/overview'],
  ['GET', '/api/admin/schedule'],
  ['GET', '/api/admin/schedule-drafts'],
  ['POST', '/api/admin/schedule-drafts'],
  ['POST', '/api/admin/schedule-history'],
  ['PUT', '/api/admin/schedule-drafts/4/template'],
  ['POST', '/api/admin/schedule-drafts/4/slots'],
  ['POST', '/api/admin/schedule-drafts/4/slots/5/remove'],
  ['PUT', '/api/admin/schedule-drafts/4/slots/5'],
  ['POST', '/api/admin/schedule-drafts/4/discard'],
  ['POST', '/api/admin/schedule-drafts/4/publish'],
  ['POST', '/api/admin/sync'],
  ['GET', '/api/admin/mb-staff'],
  ['POST', '/api/admin/import'],
  ['POST', '/api/admin/shifts'],
  ['POST', '/api/admin/shifts/4/assign'],
  ['POST', '/api/admin/shifts/4/close'],
  ['POST', '/api/admin/shifts/4/reopen'],
  ['POST', '/api/admin/claims/4/decline'],
  ['POST', '/api/admin/instructors'],
  ['PUT', '/api/admin/instructors/4'],
  ['POST', '/api/admin/instructors/4/reset-pin'],
  ['POST', '/api/admin/pins-from-phone'],
  ['GET', '/api/admin/instructors/4/timeoff'],
  ['POST', '/api/admin/instructors/4/timeoff'],
  ['DELETE', '/api/admin/timeoff/4'],
  ['GET', '/api/admin/instructors/4/availability'],
  ['PUT', '/api/admin/instructors/4/availability'],
  ['PUT', '/api/admin/settings'],
];

function mockReq(url, method = 'GET') {
  const req = Readable.from([]);
  req.method = method;
  req.url = url;
  req.headers = {};
  return req;
}

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers || {};
    },
    end(body) { this.body = body || ''; },
    get headersSent() { return this.statusCode !== 0; },
  };
}

async function call(url, method = 'GET') {
  const res = mockRes();
  await handle(mockReq(url, method), res);
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
}

describe('API routing', () => {
  it('keeps a direct URL and rebuilds one that Vercel rewrote onto the router', () => {
    assert.equal(resolveRequestUrl({ url: '/api/health' }), '/api/health');
    assert.equal(resolveRequestUrl({ url: '/api/cron/sync' }), '/api/cron/sync');
    assert.equal(
      resolveRequestUrl({ url: '/api/admin/schedule?from=2026-11-20' }),
      '/api/admin/schedule?from=2026-11-20',
    );
    assert.equal(resolveRequestUrl({ url: '/api/router?path=cron/sync' }), '/api/cron/sync');
    assert.equal(
      resolveRequestUrl({ url: '/api/router?path=admin/schedule&from=2026-11-20' }),
      '/api/admin/schedule?from=2026-11-20',
    );
    assert.equal(resolveRequestUrl({ url: '/api/router?path=admin%2Fshifts%2F3%2Fassign' }), '/api/admin/shifts/3/assign');
    assert.equal(resolveRequestUrl({ url: '/api/[...path]?path=my/overview' }), '/api/my/overview');
  });

  it('matches every route the front end calls, including nested ones', () => {
    for (const [method, path] of FRONTEND_ROUTES) {
      assert.equal(matchRoute(method, path), true, `${method} ${path}`);
    }
    assert.equal(matchRoute('GET', '/api/cron/sync'), true);
    assert.equal(matchRoute('POST', '/api/cron/sync'), true);
    assert.equal(matchRoute('GET', '/api/health'), true);
    assert.equal(matchRoute('GET', '/api/a/b/c'), false);
  });

  it('answers nested paths from the app handler, including the rewritten form', async () => {
    const cron = await call('/api/cron/sync');
    assert.equal(cron.status, 401);
    assert.equal(cron.body.error, 'Unauthorised');

    const rewrittenCron = await call('/api/router?path=cron/sync');
    assert.equal(rewrittenCron.status, 401);
    assert.equal(rewrittenCron.body.error, 'Unauthorised');

    const overview = await call('/api/router?path=my/overview');
    assert.equal(overview.status, 401);

    const assign = await call('/api/router?path=admin/shifts/4/assign', 'POST');
    assert.equal(assign.status, 401);

    const reset = await call('/api/router?path=admin/instructors/4/reset-pin', 'POST');
    assert.equal(reset.status, 401);

    const schedule = await call('/api/router?path=admin/schedule&from=2026-11-20');
    assert.equal(schedule.status, 401);

    const missing = await call('/api/router?path=a/b/c');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'Not found');

    const direct = await call('/api/admin/shifts/4/close', 'POST');
    assert.equal(direct.status, 401);
  });

  it('rewrites nested /api paths onto the router in vercel.json', () => {
    const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
    assert.deepEqual(config.rewrites, [
      { source: '/api/:path*', destination: '/api/router?path=:path*' },
    ]);
    assert.equal(config.crons[0].path, '/api/cron/sync');
    assert.equal(config.functions['api/cron/sync.js'].maxDuration, 60);
    assert.equal(config.functions['api/router.js'].maxDuration, 60);
  });
});
