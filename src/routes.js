// HTTP API. Who is calling comes from the session cookie, never from the body or the URL.
import { prepare, transaction, getSetting, setSetting } from './db.js';
import {
  nowLocal, todayLocal, addDays, toMin, reconcile, matchInstructor, awayRecord,
  fitsWeekly, teachingConflict, candidatesFor, isPlaceholder, placeholderName, classesCoveredBy,
} from './logic.js';
import { mbConfigured, mbCanWrite, syncClasses, fetchStaff, pushSubstitute } from './mindbody.js';
import {
  publicUser, canTeach, canDesk, isManager, loadUserByToken, destroySession,
  verifyLogin, sessionCookie, clearCookie, hashPin, newPin, checkPin, nextCode,
} from './auth.js';
import { notifyTimeOff, notifyOpenedShifts, notifyClaim, notifyReminders, flushQueuedAlerts } from './alerts.js';
import { parseCsv, normDate, normTime } from './csv.js';
import { HttpError, bad, send, readBody, cookies, isDate, isTime, cronAuthorized } from './http.js';
import { withSyncLock } from './sync-lock.js';

const STAMP = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`;

async function safe(work) {
  try { await work; } catch (err) { console.error('alert failed', err.message); }
}

export async function runScheduledSync() {
  let sync;
  try {
    if (mbConfigured()) {
      sync = await syncClasses();
      await setSetting('last_sync_error', '');
    } else {
      sync = await reconcile();
    }
    await safe(notifyOpenedShifts(sync.openedRows || []));
  } catch (err) {
    await setSetting('last_sync_error', err.message);
    console.error('Sync failed', err.message);
    sync = { error: err.message };
  }
  let reminders = { considered: 0, alerts: 0 };
  let queue = { flushed: 0, waiting: 0 };
  try { reminders = await notifyReminders(); } catch (err) { console.error('reminders failed', err.message); }
  try { queue = await flushQueuedAlerts(); } catch (err) { console.error('alert flush failed', err.message); }
  return { sync, reminders, queue };
}

async function classView(c) {
  const inst = await matchInstructor(c.staff_id, c.staff_name);
  const shift = await prepare(
    "SELECT id, status, reason, assigned_instructor_id FROM shifts WHERE class_id=? AND status IN ('open','filled') ORDER BY id DESC LIMIT 1",
  ).get(c.id);
  const assigned = shift?.assigned_instructor_id
    ? (await prepare('SELECT name FROM instructors WHERE id=?').get(shift.assigned_instructor_id))?.name
    : null;
  return {
    id: c.id,
    start: c.start,
    end: c.end,
    name: c.name,
    location: c.location,
    booked: c.booked,
    capacity: c.capacity,
    cancelled: !!c.cancelled,
    staff_name: c.staff_name,
    instructor_id: inst?.id || null,
    instructor: inst?.name || null,
    placeholder: await isPlaceholder(c.staff_name),
    away: inst ? !!(await awayRecord(inst.id, c.start, c.end)) : false,
    shift: shift ? { id: shift.id, status: shift.status, reason: shift.reason, assigned } : null,
  };
}

async function shiftView(s, me = null, { personal = false } = {}) {
  const claims = await prepare(`SELECT c.id, c.status, c.created_at, c.instructor_id, i.name
    FROM claims c JOIN instructors i ON i.id = c.instructor_id
    WHERE c.shift_id=? ORDER BY c.created_at`).all(s.id);
  const orig = s.original_instructor_id
    ? (await prepare('SELECT name FROM instructors WHERE id=?').get(s.original_instructor_id))?.name
    : null;
  const assigned = s.assigned_instructor_id
    ? (await prepare('SELECT name FROM instructors WHERE id=?').get(s.assigned_instructor_id))?.name
    : null;
  const v = {
    id: s.id,
    start: s.start,
    end: s.end,
    name: s.name,
    location: s.location,
    reason: s.reason,
    status: s.status,
    original: orig,
    assigned,
    assigned_instructor_id: s.assigned_instructor_id,
    note: s.note,
    mb_note: s.mb_note,
    auto: !!s.auto,
    class_id: s.class_id,
  };
  if (me && (personal || me.role === 'sensei')) {
    const mine = claims.find((c) => c.instructor_id === me.id);
    v.my_claim = mine?.status || null;
    v.fits = await fitsWeekly(me.id, s.start, s.end);
    v.away = !!(await awayRecord(me.id, s.start, s.end));
    v.busy = !!(await teachingConflict(me, s.start, s.end, s.class_id));
    v.claimants = claims.filter((c) => c.status === 'pending').length;
  } else {
    v.claims = claims;
    if (s.status === 'open') v.candidates = await candidatesFor(s);
  }
  return v;
}

function requireUser(user) {
  if (!user) throw new HttpError(401, 'Please sign in.');
}
function requireTeach(user) {
  requireUser(user);
  if (!canTeach(user)) throw new HttpError(403, 'This is the instructor view.');
}
function requireDesk(user) {
  requireUser(user);
  if (!canDesk(user)) throw new HttpError(403, 'Front desk or managers only.');
}
function requireManager(user) {
  requireUser(user);
  if (!isManager(user)) throw new HttpError(403, 'Managers only.');
}

function validateTimeoff(b) {
  if (!isDate(b.start_date)) bad('Pick a start date.');
  const end = b.end_date || b.start_date;
  if (!isDate(end) || end < b.start_date) bad('End date must be on or after the start date.');
  if (b.start_date < todayLocal()) bad('Pick a date from today onwards.');
  const st = b.start_time || null;
  const et = b.end_time || null;
  if ((st && !isTime(st)) || (et && !isTime(et)) || (!!st !== !!et)) bad('Give both a from and to time, or leave both blank for the whole day.');
  if (st && toMin(et) <= toMin(st)) bad('The to time must be after the from time.');
  return { start_date: b.start_date, end_date: end, start_time: st, end_time: et, note: String(b.note || '').slice(0, 300) || null };
}

async function reconcileAndAlert() {
  const result = await reconcile();
  await safe(notifyOpenedShifts(result.openedRows || []));
  return result;
}

const routes = [];
function route(method, pattern, guard, fn) {
  routes.push({
    method,
    re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`),
    guard,
    fn,
  });
}

route('POST', '/api/login', null, async (req, res) => {
  const body = await readBody(req);
  const result = await verifyLogin(body.code, body.pin);
  if (!result.ok) throw new HttpError(result.status, result.error);
  send(res, 200, { user: publicUser(result.user) }, { 'Set-Cookie': sessionCookie(result.token) });
});

route('POST', '/api/logout', null, async (req, res) => {
  await destroySession(cookies(req).kp_s);
  send(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() });
});

route('GET', '/api/health', null, async (req, res) => {
  await prepare('SELECT 1 AS ok').get();
  send(res, 200, { ok: true });
});

route('GET', '/api/me', null, async (req, res, { user }) => {
  if (!user) throw new HttpError(401, 'Please sign in.');
  send(res, 200, { user: publicUser(user), today: todayLocal(), source: await getSetting('schedule_source', 'none') });
});

route('PUT', '/api/my/pin', 'user', async (req, res, { user }) => {
  const { current, next } = await readBody(req);
  if (!checkPin(String(current || ''), user.pin_hash)) bad('Current PIN is not right.');
  if (!/^\d{4,8}$/.test(String(next || ''))) bad('New PIN must be 4 to 8 digits.');
  await prepare('UPDATE instructors SET pin_hash=? WHERE id=?').run(hashPin(next), user.id);
  send(res, 200, { ok: true });
});

route('GET', '/api/my/overview', 'teach', async (req, res, { user }) => {
  const now = nowLocal();
  const until = `${addDays(todayLocal(), 28)}T23:59`;
  const classRows = await prepare('SELECT * FROM classes WHERE start>=? AND start<=? AND cancelled=FALSE ORDER BY start').all(now, until);
  const classes = [];
  for (const c of classRows) {
    const who = await matchInstructor(c.staff_id, c.staff_name);
    if (who?.id === user.id) classes.push(await classView(c));
  }
  const pickedRows = await prepare("SELECT * FROM shifts WHERE status='filled' AND assigned_instructor_id=? AND start>=? ORDER BY start").all(user.id, now);
  const picked = [];
  for (const s of pickedRows) picked.push(await shiftView(s, user, { personal: true }));
  const openRows = await prepare("SELECT * FROM shifts WHERE status='open' AND start>=? ORDER BY start").all(now);
  const shifts = [];
  for (const s of openRows) {
    if (s.original_instructor_id === user.id) continue;
    shifts.push(await shiftView(s, user, { personal: true }));
  }
  send(res, 200, {
    user: publicUser(user),
    today: todayLocal(),
    source: await getSetting('schedule_source', 'none'),
    availability: await prepare('SELECT dow, hour FROM availability WHERE instructor_id=?').all(user.id),
    timeoff: await prepare('SELECT * FROM unavailability WHERE instructor_id=? AND end_date>=? ORDER BY start_date').all(user.id, todayLocal()),
    classes,
    picked,
    shifts,
  });
});

route('PUT', '/api/my/availability', 'teach', async (req, res, { user }) => {
  const { blocks } = await readBody(req);
  if (!Array.isArray(blocks)) bad('blocks required');
  await transaction(async () => {
    await prepare('DELETE FROM availability WHERE instructor_id=?').run(user.id);
    const ins = prepare('INSERT INTO availability(instructor_id, dow, hour) VALUES(?,?,?) ON CONFLICT DO NOTHING');
    for (const pair of blocks.slice(0, 400)) {
      const [d, h] = pair;
      if (d >= 0 && d <= 6 && h >= 0 && h <= 23) await ins.run(user.id, d, h);
    }
  });
  await setSetting(`avail_updated_${user.id}`, new Date().toISOString());
  send(res, 200, { ok: true });
});

route('POST', '/api/my/timeoff', 'teach', async (req, res, { user }) => {
  const t = validateTimeoff(await readBody(req));
  const row = await prepare(`INSERT INTO unavailability(instructor_id, start_date, end_date, start_time, end_time, note)
    VALUES(?,?,?,?,?,?) RETURNING id`).get(user.id, t.start_date, t.end_date, t.start_time, t.end_time, t.note);
  const timeoff = { id: row.id, ...t };
  const result = await reconcile();
  const covered = await classesCoveredBy(user, timeoff);
  const coveredIds = new Set(covered.map((c) => c.id));
  if (covered.length) await safe(notifyTimeOff({ timeoff, instructor: user, classes: covered }));
  await safe(notifyOpenedShifts((result.openedRows || []).filter((s) => !coveredIds.has(s.class_id))));
  const picked = await prepare("SELECT * FROM shifts WHERE status='filled' AND assigned_instructor_id=? AND start>=?").all(user.id, nowLocal());
  const clashes = [];
  for (const s of picked) {
    if (await awayRecord(user.id, s.start, s.end)) clashes.push({ start: s.start, name: s.name });
  }
  send(res, 200, { id: row.id, opened: result.opened, clashes });
});

route('DELETE', '/api/my/timeoff/:id', 'teach', async (req, res, { user, params }) => {
  await prepare('DELETE FROM unavailability WHERE id=? AND instructor_id=?').run(params.id, user.id);
  await reconcileAndAlert();
  send(res, 200, { ok: true });
});

route('POST', '/api/shifts/:id/claim', 'teach', async (req, res, { user, params }) => {
  const s = await prepare('SELECT * FROM shifts WHERE id=?').get(params.id);
  if (!s || s.status !== 'open') bad('This shift is no longer open.');
  if (s.original_instructor_id === user.id) bad('This is your own class.');
  if (await awayRecord(user.id, s.start, s.end)) bad('You have marked yourself unavailable at this time.');
  const clash = await teachingConflict(user, s.start, s.end, s.class_id);
  if (clash) bad(`You are already teaching ${clash.name} at ${clash.start.slice(11)}.`);
  const claim = await prepare(`INSERT INTO claims(shift_id, instructor_id, status) VALUES(?, ?, 'pending')
    ON CONFLICT(shift_id, instructor_id) DO UPDATE
      SET status='pending', created_at=${STAMP}
    RETURNING id, created_at`).get(s.id, user.id);
  await safe(notifyClaim({ claim, instructor: user, shift: s }));
  send(res, 200, { ok: true });
});

route('DELETE', '/api/shifts/:id/claim', 'teach', async (req, res, { user, params }) => {
  await prepare("UPDATE claims SET status='withdrawn' WHERE shift_id=? AND instructor_id=? AND status='pending'").run(params.id, user.id);
  send(res, 200, { ok: true });
});

route('GET', '/api/admin/overview', 'desk', async (req, res, { user }) => {
  const now = nowLocal();
  const today = todayLocal();
  const shiftRows = await prepare("SELECT * FROM shifts WHERE start>=? AND status IN ('open','filled') ORDER BY start").all(now);
  const shifts = [];
  for (const s of shiftRows) shifts.push(await shiftView(s));
  const closedRows = await prepare("SELECT * FROM shifts WHERE start>=? AND status='closed' ORDER BY updated_at DESC LIMIT 15").all(now);
  const recentClosed = [];
  for (const s of closedRows) recentClosed.push(await shiftView(s));
  const people = await prepare("SELECT * FROM instructors WHERE role='sensei' ORDER BY active DESC, name").all();
  const instructors = [];
  for (const i of people) {
    const base = {
      ...publicUser(i),
      blocks: (await prepare('SELECT COUNT(*)::int AS n FROM availability WHERE instructor_id=?').get(i.id)).n,
    };
    if (user.role === 'manager') {
      base.has_pin = !!i.pin_hash;
      base.availability = await prepare('SELECT dow, hour FROM availability WHERE instructor_id=?').all(i.id);
      base.avail_updated = await getSetting(`avail_updated_${i.id}`);
    } else {
      delete base.mb_staff_id;
      delete base.code;
    }
    instructors.push(base);
  }
  const timeoffRows = await prepare(`SELECT u.*, i.name FROM unavailability u
    JOIN instructors i ON i.id = u.instructor_id
    WHERE u.end_date>=? ORDER BY u.start_date`).all(today);
  const timeoff = [];
  for (const t of timeoffRows) {
    const affected = await prepare(`SELECT COUNT(*)::int AS n FROM shifts
      WHERE status IN ('open','filled') AND reason='unavailable' AND original_instructor_id=?
        AND substr(start,1,10) BETWEEN ? AND ?`).get(t.instructor_id, t.start_date, t.end_date);
    timeoff.push({ ...t, affected: affected.n });
  }
  const staffRows = await prepare('SELECT DISTINCT staff_name, staff_id FROM classes WHERE start>=?').all(now);
  const unmatched = [];
  for (const c of staffRows) {
    if (!c.staff_name || await isPlaceholder(c.staff_name)) continue;
    if (!(await matchInstructor(c.staff_id, c.staff_name))) unmatched.push(c.staff_name);
  }
  const alerts = await prepare(`SELECT id, kind, shift_id, timeoff_id, body, status, channel, detail, created_at
    FROM alerts ORDER BY id DESC LIMIT 20`).all();
  send(res, 200, {
    today,
    shifts,
    recentClosed,
    instructors,
    timeoff,
    unmatched: [...new Set(unmatched)],
    alerts,
    stats: {
      open: shifts.filter((s) => s.status === 'open').length,
      pending: shifts.reduce((n, s) => n + (s.claims || []).filter((c) => c.status === 'pending').length, 0),
      filled: shifts.filter((s) => s.status === 'filled').length,
      classes: (await prepare('SELECT COUNT(*)::int AS n FROM classes WHERE start>=? AND cancelled=FALSE').get(now)).n,
    },
    sync: {
      source: await getSetting('schedule_source', 'none'),
      last: await getSetting('last_sync'),
      mindbody: mbConfigured(),
      mbWrite: mbCanWrite(),
      placeholder: await placeholderName(),
      lastError: await getSetting('last_sync_error'),
    },
  });
});

route('GET', '/api/admin/schedule', 'desk', async (req, res, { url }) => {
  const from = isDate(url.searchParams.get('from')) ? url.searchParams.get('from') : todayLocal();
  const to = addDays(from, 6);
  const rows = await prepare('SELECT * FROM classes WHERE substr(start,1,10) BETWEEN ? AND ? ORDER BY start').all(from, to);
  const classes = [];
  for (const c of rows) classes.push(await classView(c));
  send(res, 200, { from, to, classes });
});

route('POST', '/api/admin/sync', 'manager', async (req, res) => {
  if (!mbConfigured()) bad('Mindbody is not connected yet. Add the API key and site ID, or import a CSV.');
  try {
    const result = await syncClasses();
    await setSetting('last_sync_error', '');
    await safe(notifyOpenedShifts(result.openedRows || []));
    send(res, 200, { classes: result.classes, opened: result.opened, closed: result.closed });
  } catch (err) {
    await setSetting('last_sync_error', err.message);
    throw new HttpError(502, err.message);
  }
});

route('GET', '/api/admin/mb-staff', 'manager', async (req, res) => {
  if (!mbConfigured()) return send(res, 200, { staff: [] });
  send(res, 200, { staff: await fetchStaff() });
});

route('POST', '/api/admin/import', 'manager', async (req, res) => {
  const rows = parseCsv(String(await readBody(req)));
  if (rows.length < 2) bad('The file looks empty.');
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => head.findIndex((h) => names.includes(h));
  const ci = {
    date: col('date', 'class date'),
    start: col('start', 'time', 'start time', 'starttime'),
    end: col('end', 'end time', 'endtime'),
    name: col('class', 'class name', 'name', 'type'),
    staff: col('instructor', 'staff', 'teacher', 'sensei', 'staff name'),
    loc: col('location', 'studio'),
  };
  if (ci.date < 0 || ci.start < 0 || ci.name < 0 || ci.staff < 0) bad('Needs columns: date, start, class, instructor (end and location are optional).');
  const mins = Number(await getSetting('class_minutes', 50));
  const parsed = [];
  for (const r of rows.slice(1)) {
    const date = normDate(r[ci.date] || '');
    const st = normTime(r[ci.start] || '');
    if (!date || !st) continue;
    let et = ci.end >= 0 ? normTime(r[ci.end] || '') : null;
    if (!et) {
      const e = toMin(st) + mins;
      et = `${String(Math.floor(e / 60)).padStart(2, '0')}:${String(e % 60).padStart(2, '0')}`;
    }
    const name = (r[ci.name] || '').trim();
    const loc = ci.loc >= 0 ? (r[ci.loc] || '').trim() : null;
    parsed.push({ id: `csv:${date}T${st}:${loc || ''}:${name}`, start: `${date}T${st}`, end: `${date}T${et}`, name, staff: (r[ci.staff] || '').trim(), loc });
  }
  if (!parsed.length) bad('No rows with a readable date and time.');
  const dates = parsed.map((p) => p.start.slice(0, 10)).sort();
  await transaction(async () => {
    await prepare("DELETE FROM classes WHERE source<>'mindbody' AND substr(start,1,10) BETWEEN ? AND ?").run(dates[0], dates.at(-1));
    const ins = prepare(`INSERT INTO classes(id, start, "end", name, staff_name, location, source) VALUES(?,?,?,?,?,?,'csv')
      ON CONFLICT(id) DO UPDATE SET start=EXCLUDED.start, "end"=EXCLUDED."end", name=EXCLUDED.name,
        staff_name=EXCLUDED.staff_name, location=EXCLUDED.location, source='csv'`);
    for (const p of parsed) await ins.run(p.id, p.start, p.end, p.name, p.staff, p.loc || null);
  });
  await setSetting('schedule_source', 'csv');
  await setSetting('last_sync', new Date().toISOString());
  const result = await reconcileAndAlert();
  send(res, 200, { classes: parsed.length, from: dates[0], to: dates.at(-1), opened: result.opened, closed: result.closed });
});

route('POST', '/api/admin/reconcile', 'manager', async (req, res) => {
  const result = await reconcileAndAlert();
  send(res, 200, { opened: result.opened, closed: result.closed });
});

route('POST', '/api/admin/shifts', 'desk', async (req, res) => {
  const b = await readBody(req);
  if (!isDate(b.date) || !isTime(b.start) || !isTime(b.end) || toMin(b.end) <= toMin(b.start)) bad('Give a date, a start and an end time.');
  if (!String(b.name || '').trim()) bad('Give the class a name.');
  const row = await prepare(`INSERT INTO shifts(auto, start, "end", name, location, reason, note, status)
    VALUES(FALSE, ?, ?, ?, ?, 'manual', ?, 'open') RETURNING id`)
    .get(`${b.date}T${b.start}`, `${b.date}T${b.end}`, b.name.trim(), b.location || null, b.note || null);
  send(res, 200, { id: row.id });
});

route('POST', '/api/admin/shifts/:id/assign', 'desk', async (req, res, { params }) => {
  const { instructor_id } = await readBody(req);
  const s = await prepare('SELECT * FROM shifts WHERE id=?').get(params.id);
  if (!s || s.status === 'closed') bad('Shift not found or closed.');
  const inst = await prepare("SELECT * FROM instructors WHERE id=? AND role='sensei'").get(Number(instructor_id));
  if (!inst) bad('Pick an instructor.');
  let mb_note = null;
  const writable = s.class_id && !String(s.class_id).startsWith('csv:') && !String(s.class_id).startsWith('demo:');
  if (writable && mbCanWrite()) {
    if (!inst.mb_staff_id) mb_note = `Not updated in Mindbody: ${inst.name} has no Mindbody staff ID linked. Update the class by hand.`;
    else {
      try {
        await pushSubstitute(s.class_id, inst.mb_staff_id);
        mb_note = `Updated in Mindbody ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;
      } catch (err) {
        mb_note = `Mindbody update failed: ${err.message}. Update the class by hand.`;
      }
    }
  } else mb_note = 'Update the instructor on this class in Mindbody.';
  await transaction(async () => {
    await prepare(`UPDATE shifts SET status='filled', assigned_instructor_id=?, mb_note=?, updated_at=${STAMP} WHERE id=?`).run(inst.id, mb_note, s.id);
    await prepare(`INSERT INTO claims(shift_id, instructor_id, status) VALUES(?, ?, 'approved')
      ON CONFLICT(shift_id, instructor_id) DO UPDATE SET status='approved'`).run(s.id, inst.id);
    await prepare("UPDATE claims SET status='declined' WHERE shift_id=? AND instructor_id<>? AND status='pending'").run(s.id, inst.id);
  });
  send(res, 200, { ok: true, mb_note });
});

route('POST', '/api/admin/claims/:id/decline', 'desk', async (req, res, { params }) => {
  await prepare("UPDATE claims SET status='declined' WHERE id=? AND status='pending'").run(params.id);
  send(res, 200, { ok: true });
});

route('POST', '/api/admin/shifts/:id/close', 'desk', async (req, res, { params }) => {
  const body = await readBody(req);
  const note = body && typeof body === 'object' ? body.note : null;
  await prepare(`UPDATE shifts SET status='closed', note=?, updated_at=${STAMP} WHERE id=?`).run(note || 'Closed by admin', params.id);
  await prepare("UPDATE claims SET status='withdrawn' WHERE shift_id=? AND status='pending'").run(params.id);
  send(res, 200, { ok: true });
});

route('POST', '/api/admin/shifts/:id/reopen', 'desk', async (req, res, { params }) => {
  await prepare(`UPDATE shifts SET status='open', assigned_instructor_id=NULL, mb_note=NULL, note=NULL, updated_at=${STAMP} WHERE id=?`).run(params.id);
  await prepare("UPDATE claims SET status='withdrawn' WHERE shift_id=? AND status='approved'").run(params.id);
  send(res, 200, { ok: true });
});

route('POST', '/api/admin/instructors', 'manager', async (req, res) => {
  const b = await readBody(req);
  const name = String(b.name || '').trim();
  if (!name) bad('Name is required.');
  const code = String(b.code || '').trim().toUpperCase() || await nextCode();
  if (!/^[A-Z0-9-]{3,20}$/.test(code)) bad('Login ID: 3 to 20 letters or numbers.');
  if (await prepare('SELECT 1 FROM instructors WHERE UPPER(code)=?').get(code)) bad('That login ID is taken.');
  const role = b.role && ['sensei', 'front_desk', 'manager'].includes(b.role) ? b.role : 'sensei';
  const pin = newPin();
  const row = await prepare(`INSERT INTO instructors(code, name, mb_staff_id, mb_name, pin_hash, role)
    VALUES(?,?,?,?,?,?) RETURNING id`).get(code, name, b.mb_staff_id || null, b.mb_name || null, hashPin(pin), role);
  await reconcileAndAlert();
  send(res, 200, { id: row.id, code, pin });
});

route('PUT', '/api/admin/instructors/:id', 'manager', async (req, res, { params }) => {
  const b = await readBody(req);
  const existing = await prepare('SELECT * FROM instructors WHERE id=?').get(params.id);
  if (!existing) bad('Not found');
  const code = String(b.code ?? existing.code).trim().toUpperCase();
  if (!/^[A-Z0-9-]{3,20}$/.test(code)) bad('Login ID: 3 to 20 letters or numbers.');
  if (await prepare('SELECT 1 FROM instructors WHERE UPPER(code)=? AND id<>?').get(code, existing.id)) bad('That login ID is taken.');
  const role = b.role && ['sensei', 'front_desk', 'manager'].includes(b.role) ? b.role : existing.role;
  const active = b.active === undefined ? existing.active : !!b.active;
  if (existing.role === 'manager' && (role !== 'manager' || active === false)) {
    const left = await prepare("SELECT COUNT(*)::int AS n FROM instructors WHERE role='manager' AND active=TRUE AND id<>?").get(existing.id);
    if (!left.n) bad('Keep at least one active manager.');
  }
  const mbStaff = Object.prototype.hasOwnProperty.call(b, 'mb_staff_id') ? (b.mb_staff_id || null) : existing.mb_staff_id;
  const mbName = Object.prototype.hasOwnProperty.call(b, 'mb_name') ? (b.mb_name || null) : existing.mb_name;
  await prepare('UPDATE instructors SET code=?, name=?, mb_staff_id=?, mb_name=?, active=?, role=? WHERE id=?')
    .run(code, String(b.name ?? existing.name).trim(), mbStaff, mbName, active, role, existing.id);
  if (active === false) await prepare('DELETE FROM sessions WHERE instructor_id=?').run(existing.id);
  await reconcileAndAlert();
  send(res, 200, { ok: true });
});

route('POST', '/api/admin/instructors/:id/reset-pin', 'manager', async (req, res, { params }) => {
  const existing = await prepare('SELECT id FROM instructors WHERE id=?').get(params.id);
  if (!existing) bad('Not found');
  const pin = newPin();
  await prepare('UPDATE instructors SET pin_hash=? WHERE id=?').run(hashPin(pin), params.id);
  await prepare('DELETE FROM sessions WHERE instructor_id=?').run(params.id);
  send(res, 200, { pin });
});

route('PUT', '/api/admin/settings', 'manager', async (req, res) => {
  const b = await readBody(req);
  if (b.placeholder_name !== undefined) {
    if (!String(b.placeholder_name).trim()) bad('Placeholder name cannot be blank.');
    await setSetting('placeholder_name', String(b.placeholder_name).trim());
  }
  const result = await reconcileAndAlert();
  send(res, 200, { opened: result.opened, closed: result.closed });
});

async function runCron(req, res) {
  if (!cronAuthorized(req)) throw new HttpError(401, 'Unauthorised');
  // 200 when another sync holds the lock, so a second caller (Vercel plus GitHub) is a no-op.
  send(res, 200, await withSyncLock(() => runScheduledSync()));
}

route('GET', '/api/cron/sync', null, runCron);
route('POST', '/api/cron/sync', null, runCron);

export async function dispatch(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const user = await loadUserByToken(cookies(req).kp_s);
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.re);
    if (!m) continue;
    if (r.guard === 'user') requireUser(user);
    if (r.guard === 'teach') requireTeach(user);
    if (r.guard === 'desk') requireDesk(user);
    if (r.guard === 'manager') requireManager(user);
    if (req.method !== 'GET' && req.headers.origin) {
      let originHost = '';
      try { originHost = new URL(req.headers.origin).host; } catch { throw new HttpError(403, 'Bad origin'); }
      if (originHost !== req.headers.host) throw new HttpError(403, 'Bad origin');
    }
    const params = { ...(m.groups || {}) };
    if (params.id != null && /^\d+$/.test(params.id)) params.id = Number(params.id);
    return r.fn(req, res, { user, params, url });
  }
  throw new HttpError(404, 'Not found');
}
