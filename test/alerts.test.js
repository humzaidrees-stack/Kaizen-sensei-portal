import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb } from './helpers.js';
import { closePool, prepare } from '../src/db.js';
import { inAlertWindow, hourInStudio } from '../src/logic.js';
import { enqueueAlert, flushQueuedAlerts, formatAwayRange, formatClassMoment, formatSlackMessage, deliverAlert, SLACK_HEADING, SLACK_TIMEOUT_MS } from '../src/alerts.js';

const INSIDE = new Date('2026-06-01T06:00:00Z'); // 10:00 Asia/Dubai
const OUTSIDE = new Date('2026-06-01T18:30:00Z'); // 22:30 Asia/Dubai

describe('desk alerts', { concurrency: 1 }, () => {
  before(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });
  after(async () => { await closePool(); });

  it('formats the handoff messages and the Dubai quiet hours', () => {
    assert.equal(formatClassMoment('2026-11-21T15:00'), 'Sat 21 Nov, 15:00');
    assert.equal(formatAwayRange({ start_date: '2026-12-06', end_date: '2026-12-21' }), '6 to 21 Dec');
    assert.equal(hourInStudio(new Date('2026-06-01T04:00:00Z')), 8);
    assert.equal(inAlertWindow(new Date('2026-06-01T04:00:00Z')), true);
    assert.equal(inAlertWindow(new Date('2026-06-01T03:59:00Z')), false);
    assert.equal(inAlertWindow(new Date('2026-06-01T16:59:00Z')), true);
    assert.equal(inAlertWindow(new Date('2026-06-01T17:00:00Z')), false);
  });

  it('queues outside 08:00–21:00 and logs immediately when WhatsApp and email are unset', async () => {
    const queued = await enqueueAlert({
      dedupeKey: 'q1', kind: 'timeoff', body: 'Christina is away 6 to 21 Dec. 14 classes need cover.',
    }, { now: OUTSIDE });
    assert.equal(queued.status, 'queued');
    const logged = await enqueueAlert({
      dedupeKey: 'q2', kind: 'sensei', body: 'Sat 21 Nov, 15:00 Active Sculpt has no instructor.',
    }, { now: INSIDE });
    assert.equal(logged.status, 'logged');
    assert.equal(logged.channel, 'log');
    assert.match(logged.detail, /slack_not_configured/);
    assert.match(logged.detail, /whatsapp_not_configured/);
    assert.match(logged.detail, /email_not_configured/);
    const flushed = await flushQueuedAlerts(INSIDE);
    assert.equal(flushed.flushed, 1);
    const row = await prepare("SELECT status, channel FROM alerts WHERE dedupe_key='q1'").get();
    assert.equal(row.status, 'logged');
    assert.equal(row.channel, 'log');
  });

  it('DMs Grace on Slack with a copyable group message and does not also call WhatsApp', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_ALERT_CHANNEL = 'U012GRACE';
    process.env.APP_BASE_URL = 'https://kaizen-sensei-portal.vercel.app';
    process.env.WA_TOKEN = 'token';
    process.env.WA_PHONE_NUMBER_ID = '555';
    process.env.WA_TEMPLATE_NAME = 'kaizen_desk_alert';
    process.env.FRONT_DESK_WA_E164 = '971500000000';
    const plain = 'Christina is away 6 to 21 Dec. 14 classes need cover.';
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers, signal: init.signal });
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, ts: '1710000000.000100' }) };
    };
    try {
      const row = await enqueueAlert({ dedupeKey: 'sl-1', kind: 'timeoff', body: plain }, { now: INSIDE });
      assert.equal(row.status, 'sent');
      assert.equal(row.channel, 'slack');
      assert.equal(row.detail, '1710000000.000100');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://slack.com/api/chat.postMessage');
      assert.equal(calls[0].headers.Authorization, 'Bearer xoxb-test');
      assert.equal(calls[0].body.channel, 'U012GRACE');
      assert.equal(calls[0].signal.aborted, false);
      assert.equal(SLACK_TIMEOUT_MS, 8000);
      const formatted = formatSlackMessage(plain);
      assert.equal(calls[0].body.text, formatted.text);
      assert.equal(calls[0].body.text.startsWith(`${SLACK_HEADING}\n`), true);
      const fenced = calls[0].body.text.split('```')[1].trim();
      assert.equal(fenced, plain);
      assert.equal(fenced.includes('*'), false);
      assert.match(calls[0].body.text, /Open shifts: https:\/\/kaizen-sensei-portal\.vercel\.app\/#\/shifts/);
      assert.equal(calls[0].body.blocks[1].text.text, `\`\`\`\n${plain}\n\`\`\``);
    } finally {
      globalThis.fetch = original;
      delete process.env.SLACK_BOT_TOKEN;
      delete process.env.SLACK_ALERT_CHANNEL;
      process.env.APP_BASE_URL = '';
      delete process.env.WA_TOKEN;
      delete process.env.WA_PHONE_NUMBER_ID;
      delete process.env.WA_TEMPLATE_NAME;
      delete process.env.FRONT_DESK_WA_E164;
    }
  });

  it('records slack_error when Slack returns 200 with ok false, then uses WhatsApp', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_ALERT_CHANNEL = 'C012';
    process.env.WA_TOKEN = 'token';
    process.env.WA_PHONE_NUMBER_ID = '555';
    process.env.WA_TEMPLATE_NAME = 'kaizen_desk_alert';
    process.env.FRONT_DESK_WA_E164 = '971500000000';
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('slack.com')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: false, error: 'not_in_channel' }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ messages: [{ id: 'wamid.FALLBACK' }] }) };
    };
    try {
      const row = await enqueueAlert({
        dedupeKey: 'sl-err', kind: 'sensei', body: 'Sat 21 Nov, 15:00 Active Sculpt has no instructor.',
      }, { now: INSIDE });
      assert.equal(row.status, 'sent');
      assert.equal(row.channel, 'whatsapp');
      assert.equal(row.detail, 'wamid.FALLBACK');
    } finally {
      globalThis.fetch = original;
      delete process.env.SLACK_BOT_TOKEN;
      delete process.env.SLACK_ALERT_CHANNEL;
      delete process.env.WA_TOKEN;
      delete process.env.WA_PHONE_NUMBER_ID;
      delete process.env.WA_TEMPLATE_NAME;
      delete process.env.FRONT_DESK_WA_E164;
    }
  });

  it('keeps slack_error:not_in_channel when no fallback is configured', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_ALERT_CHANNEL = 'U012GRACE';
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: false, error: 'not_in_channel' }) });
    try {
      const row = await enqueueAlert({
        dedupeKey: 'sl-only', kind: 'claim', body: 'Claudia asked for Sat 21 Nov, 15:00 Active Sculpt.',
      }, { now: INSIDE });
      assert.equal(row.status, 'queued');
      assert.match(row.detail, /slack_error:not_in_channel/);
      assert.match(row.detail, /whatsapp_not_configured/);
    } finally {
      globalThis.fetch = original;
      delete process.env.SLACK_BOT_TOKEN;
      delete process.env.SLACK_ALERT_CHANNEL;
    }
  });

  it('sends one WhatsApp template to the front desk number and does not duplicate it', async () => {
    process.env.WA_TOKEN = 'token';
    process.env.WA_PHONE_NUMBER_ID = '555';
    process.env.WA_TEMPLATE_NAME = 'kaizen_desk_alert';
    process.env.FRONT_DESK_WA_E164 = '+971 50 000 0000';
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
      return { ok: true, text: async () => JSON.stringify({ messages: [{ id: 'wamid.ABC' }] }) };
    };
    try {
      const first = await enqueueAlert({
        dedupeKey: 'wa-1', kind: 'claim', body: 'Claudia asked for Sat 21 Nov, 15:00 Active Sculpt.',
      }, { now: INSIDE });
      const second = await enqueueAlert({
        dedupeKey: 'wa-1', kind: 'claim', body: 'Claudia asked for Sat 21 Nov, 15:00 Active Sculpt.',
      }, { now: INSIDE });
      assert.equal(first.status, 'sent');
      assert.equal(first.channel, 'whatsapp');
      assert.equal(first.detail, 'wamid.ABC');
      assert.equal(second.id, first.id);
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /\/v21\.0\/555\/messages$/);
      assert.equal(calls[0].body.to, '971500000000');
      assert.equal(calls[0].body.type, 'template');
      assert.equal(calls[0].body.template.name, 'kaizen_desk_alert');
      assert.equal(calls[0].body.template.components[0].parameters[0].text, 'Claudia asked for Sat 21 Nov, 15:00 Active Sculpt.');
      assert.equal(calls[0].headers.Authorization, 'Bearer token');
    } finally {
      globalThis.fetch = original;
      delete process.env.WA_TOKEN;
      delete process.env.WA_PHONE_NUMBER_ID;
      delete process.env.WA_TEMPLATE_NAME;
      delete process.env.FRONT_DESK_WA_E164;
    }
  });

  it('falls back to email when WhatsApp is not configured', async () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.ALERT_EMAIL_FROM = 'Kaizen <desk@kaizen.example>';
    process.env.ALERT_EMAIL_TO = 'frontdesk@kaizen.example';
    const original = globalThis.fetch;
    let payload = null;
    globalThis.fetch = async (url, init) => {
      payload = { url: String(url), body: JSON.parse(init.body) };
      return { ok: true, text: async () => JSON.stringify({ id: 'email_1' }) };
    };
    try {
      const row = await enqueueAlert({
        dedupeKey: 'em-1', kind: 'reminder', body: 'Still open: Sat 21 Nov, 15:00 Active Sculpt.',
      }, { now: INSIDE });
      assert.equal(row.status, 'sent');
      assert.equal(row.channel, 'email');
      assert.match(payload.url, /api\.resend\.com\/emails/);
      assert.deepEqual(payload.body.to, ['frontdesk@kaizen.example']);
    } finally {
      globalThis.fetch = original;
      delete process.env.RESEND_API_KEY;
      delete process.env.ALERT_EMAIL_FROM;
      delete process.env.ALERT_EMAIL_TO;
    }
  });

  it('retries a failed WhatsApp send from the queue instead of throwing', async () => {
    process.env.WA_TOKEN = 'token';
    process.env.WA_PHONE_NUMBER_ID = '555';
    process.env.WA_TEMPLATE_NAME = 'kaizen_desk_alert';
    process.env.FRONT_DESK_WA_E164 = '971500000000';
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => JSON.stringify({ error: { message: 'unavailable' } }) });
    try {
      const row = await enqueueAlert({
        dedupeKey: 'retry-1', kind: 'sensei', body: 'Sat 21 Nov, 15:00 Active Sculpt has no instructor.',
      }, { now: INSIDE });
      assert.equal(row.status, 'queued');
      assert.match(row.detail, /unavailable/);
      globalThis.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ messages: [{ id: 'wamid.RETRY' }] }) });
      await deliverAlert(row.id);
      const saved = await prepare('SELECT status, channel, detail FROM alerts WHERE id=?').get(row.id);
      assert.equal(saved.status, 'sent');
      assert.equal(saved.channel, 'whatsapp');
    } finally {
      globalThis.fetch = original;
      delete process.env.WA_TOKEN;
      delete process.env.WA_PHONE_NUMBER_ID;
      delete process.env.WA_TEMPLATE_NAME;
      delete process.env.FRONT_DESK_WA_E164;
    }
  });
});
