// Front-desk alerts. One WhatsApp utility template to the desk number, otherwise
// email (Resend), otherwise a log line plus a row in `alerts`. Nothing is thrown
// when the env vars are missing. Outside 08:00–21:00 Asia/Dubai the row is queued
// and the cron route sends it in the morning.
import { prepare } from './db.js';
import { inAlertWindow, addHoursLocal, nowLocal } from './logic.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function formatClassMoment(start) {
  const d = new Date(start.slice(0, 10) + 'T12:00:00Z');
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${start.slice(11, 16)}`;
}

export function formatAwayRange(t) {
  const part = (date) => {
    const d = new Date(date + 'T12:00:00Z');
    return { day: d.getUTCDate(), mon: MONTHS[d.getUTCMonth()] };
  };
  const a = part(t.start_date);
  const b = part(t.end_date);
  let dates;
  if (t.start_date === t.end_date) dates = `${a.day} ${a.mon}`;
  else if (a.mon === b.mon) dates = `${a.day} to ${b.day} ${a.mon}`;
  else dates = `${a.day} ${a.mon} to ${b.day} ${b.mon}`;
  if (t.start_time && t.end_time) return `${dates}, ${t.start_time.slice(0, 5)} to ${t.end_time.slice(0, 5)}`;
  return dates;
}

function firstName(name) {
  return String(name || 'Someone').trim().split(/\s+/)[0];
}

function withLink(text) {
  const base = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  const link = base ? ` Open shifts: ${base}/#/shifts` : '';
  return `${text}${link}`.replace(/\s+/g, ' ').trim();
}

export function whatsAppConfigured() {
  return !!(process.env.WA_TOKEN && process.env.WA_PHONE_NUMBER_ID && process.env.WA_TEMPLATE_NAME && process.env.FRONT_DESK_WA_E164);
}

export function emailConfigured() {
  return !!(process.env.RESEND_API_KEY && process.env.ALERT_EMAIL_FROM && process.env.ALERT_EMAIL_TO);
}

async function tryWhatsApp(text) {
  if (!whatsAppConfigured()) return { ok: false, detail: 'whatsapp_not_configured' };
  const to = String(process.env.FRONT_DESK_WA_E164).replace(/[^\d]/g, '');
  const version = process.env.WA_GRAPH_VERSION || 'v21.0';
  const url = `https://graph.facebook.com/${version}/${process.env.WA_PHONE_NUMBER_ID}/messages`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WA_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: process.env.WA_TEMPLATE_NAME,
          language: { code: process.env.WA_TEMPLATE_LANG || 'en' },
          components: [{
            type: 'body',
            parameters: [{ type: 'text', text: text.slice(0, 900) }],
          }],
        },
      }),
    });
    const raw = await res.text();
    let json = {};
    try { json = raw ? JSON.parse(raw) : {}; } catch { json = { raw: raw.slice(0, 300) }; }
    if (!res.ok) {
      const msg = json?.error?.message || raw.slice(0, 300) || `HTTP ${res.status}`;
      return { ok: false, detail: `whatsapp ${res.status}: ${msg}` };
    }
    return { ok: true, detail: json?.messages?.[0]?.id || 'accepted' };
  } catch (err) {
    return { ok: false, detail: `whatsapp error: ${err.message}` };
  }
}

async function tryEmail(text) {
  if (!emailConfigured()) return { ok: false, detail: 'email_not_configured' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.ALERT_EMAIL_FROM,
        to: [process.env.ALERT_EMAIL_TO],
        subject: 'Kaizen Sensei: cover needed',
        text,
      }),
    });
    const raw = await res.text();
    let json = {};
    try { json = raw ? JSON.parse(raw) : {}; } catch { json = {}; }
    if (!res.ok) return { ok: false, detail: `email ${res.status}: ${json?.message || raw.slice(0, 200)}` };
    return { ok: true, detail: json.id || 'accepted' };
  } catch (err) {
    return { ok: false, detail: `email error: ${err.message}` };
  }
}

// Sends now. Callers only invoke this inside the alert window (or in tests with force).
export async function deliverAlert(id) {
  const alert = await prepare('SELECT * FROM alerts WHERE id=?').get(id);
  if (!alert || alert.status === 'sent' || alert.status === 'logged' || alert.status === 'failed') return alert;
  const attempts = (alert.attempts || 0) + 1;
  const wa = await tryWhatsApp(alert.body);
  const email = wa.ok ? { ok: false, detail: '' } : await tryEmail(alert.body);
  let status = 'logged';
  let channel = 'log';
  let detail = '';
  if (wa.ok) {
    status = 'sent';
    channel = 'whatsapp';
    detail = wa.detail;
  } else if (email.ok) {
    status = 'sent';
    channel = 'email';
    detail = email.detail;
  } else if (wa.detail === 'whatsapp_not_configured') {
    detail = [wa.detail, email.detail].filter(Boolean).join('; ');
    console.log(`[kaizen-alert] ${alert.body} (${detail})`);
  } else if (attempts < 5) {
    status = 'queued';
    channel = null;
    detail = [wa.detail, email.detail].filter(Boolean).join('; ');
  } else {
    status = 'failed';
    detail = [wa.detail, email.detail].filter(Boolean).join('; ');
    console.log(`[kaizen-alert] ${alert.body} (${detail})`);
  }
  await prepare(`UPDATE alerts
    SET status=?, channel=?, detail=?, attempts=?,
        sent_at=CASE WHEN ? IN ('sent','logged','failed')
          THEN to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
          ELSE sent_at END
    WHERE id=?`).run(status, channel, detail || null, attempts, status, id);
  return prepare('SELECT * FROM alerts WHERE id=?').get(id);
}

export async function enqueueAlert({ dedupeKey, kind, shiftId = null, timeoffId = null, body, payload = {} }, { now = new Date() } = {}) {
  const existing = await prepare('SELECT id, status, channel FROM alerts WHERE dedupe_key=?').get(dedupeKey);
  if (existing) return existing;
  const open = inAlertWindow(now);
  const status = open ? 'pending' : 'queued';
  const row = await prepare(`INSERT INTO alerts(dedupe_key, kind, shift_id, timeoff_id, body, payload, status)
    VALUES(?,?,?,?,?,?::jsonb,?)
    ON CONFLICT(dedupe_key) DO NOTHING
    RETURNING id, status`).get(dedupeKey, kind, shiftId, timeoffId, body, JSON.stringify(payload), status);
  if (!row) return prepare('SELECT id, status, channel FROM alerts WHERE dedupe_key=?').get(dedupeKey);
  if (!open) return row;
  return deliverAlert(row.id);
}

export async function notifyTimeOff({ timeoff, instructor, classes }) {
  if (!classes?.length) return null;
  const n = classes.length;
  const body = withLink(`${firstName(instructor.name)} is away ${formatAwayRange(timeoff)}. ${n} ${n === 1 ? 'class needs' : 'classes need'} cover.`);
  return enqueueAlert({
    dedupeKey: `timeoff:${timeoff.id}`,
    kind: 'timeoff',
    timeoffId: timeoff.id,
    body,
    payload: { class_ids: classes.map((c) => c.id), instructor_id: instructor.id },
  });
}

export async function notifyOpenedShifts(openedRows) {
  const sent = [];
  for (const shift of openedRows.filter((s) => s.reason === 'sensei')) {
    const body = withLink(`${formatClassMoment(shift.start)} ${shift.name} has no instructor.`);
    sent.push(await enqueueAlert({
      dedupeKey: `sensei:${shift.class_id || shift.id}`,
      kind: 'sensei',
      shiftId: shift.id,
      body,
      payload: { class_id: shift.class_id },
    }));
  }
  const groups = new Map();
  for (const shift of openedRows.filter((s) => s.reason === 'unavailable' && s.original_instructor_id)) {
    if (!groups.has(shift.original_instructor_id)) groups.set(shift.original_instructor_id, []);
    groups.get(shift.original_instructor_id).push(shift);
  }
  for (const [instructorId, shifts] of groups) {
    const inst = await prepare('SELECT id, name FROM instructors WHERE id=?').get(instructorId);
    const ids = shifts.map((s) => s.id).sort((a, b) => a - b).join(',');
    const n = shifts.length;
    const body = withLink(`${firstName(inst?.name)} is away and ${n} ${n === 1 ? 'class needs' : 'classes need'} cover.`);
    sent.push(await enqueueAlert({
      dedupeKey: `unavailable:${instructorId}:${ids}`,
      kind: 'unavailable',
      shiftId: shifts[0].id,
      body,
      payload: { shift_ids: shifts.map((s) => s.id), instructor_id: instructorId },
    }));
  }
  return sent;
}

export async function notifyClaim({ claim, instructor, shift }) {
  const body = withLink(`${firstName(instructor.name)} asked for ${formatClassMoment(shift.start)} ${shift.name}.`);
  return enqueueAlert({
    dedupeKey: `claim:${claim.id}:${claim.created_at}`,
    kind: 'claim',
    shiftId: shift.id,
    body,
    payload: { claim_id: claim.id, instructor_id: instructor.id },
  });
}

export async function notifyReminders() {
  const now = nowLocal();
  const until = addHoursLocal(now, 48);
  const shifts = await prepare("SELECT * FROM shifts WHERE status='open' AND start>=? AND start<=? ORDER BY start").all(now, until);
  let n = 0;
  for (const shift of shifts) {
    const body = withLink(`Still open: ${formatClassMoment(shift.start)} ${shift.name}.`);
    const row = await enqueueAlert({
      dedupeKey: `reminder:${shift.id}`,
      kind: 'reminder',
      shiftId: shift.id,
      body,
      payload: { class_id: shift.class_id },
    });
    if (row) n++;
  }
  return { considered: shifts.length, alerts: n };
}

export async function flushQueuedAlerts(now = new Date()) {
  if (!inAlertWindow(now)) {
    const waiting = await prepare("SELECT COUNT(*)::int AS n FROM alerts WHERE status='queued'").get();
    return { flushed: 0, waiting: waiting?.n || 0 };
  }
  const rows = await prepare("SELECT id FROM alerts WHERE status='queued' ORDER BY id").all();
  for (const row of rows) await deliverAlert(row.id);
  return { flushed: rows.length, waiting: 0 };
}
