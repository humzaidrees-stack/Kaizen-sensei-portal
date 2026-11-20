// Scheduling rules, ported from the reference app's logic.js.
// Who is available, who is away, and which classes need cover.
import { prepare, transaction, getSetting } from './db.js';

export function studioTz() {
  return process.env.STUDIO_TZ || 'Asia/Dubai';
}

// Studio-local time as 'YYYY-MM-DDTHH:MM'. `hourCycle: 'h23'` can report 24 at midnight.
export function nowLocal(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: studioTz(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}`;
}

export const todayLocal = (date) => nowLocal(date).slice(0, 10);

export const toMin = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + m;
};

export const dowOf = (date) => (new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7; // Mon = 0

export function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Add hours to a studio-local 'YYYY-MM-DDTHH:MM' clock time (Dubai has no DST).
export function addHoursLocal(local, hours) {
  const [date, time] = local.split('T');
  const [Y, M, D] = date.split('-').map(Number);
  const [h, m] = time.split(':').map(Number);
  const dt = new Date(Date.UTC(Y, M - 1, D, h + hours, m));
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}T${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}`;
}

export function hourInStudio(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: studioTz(),
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const raw = parts.find((p) => p.type === 'hour')?.value;
  const n = Number(raw);
  return n === 24 ? 0 : n;
}

// Desk messages go out from 08:00 inclusive until 21:00 exclusive, Asia/Dubai.
export function inAlertWindow(date = new Date()) {
  const hour = hourInStudio(date);
  return hour >= 8 && hour < 21;
}

export async function placeholderName() {
  return getSetting('placeholder_name', 'Kaizen Sensei');
}

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z]/g, '');

export async function isPlaceholder(staffName) {
  const ph = norm(await placeholderName());
  const n = norm(staffName);
  return !!ph && (n === ph || n.includes(ph));
}

function isPlaceholderNamed(staffName, placeholder) {
  const ph = norm(placeholder);
  const n = norm(staffName);
  return !!ph && (n === ph || n.includes(ph));
}

// Match a class's Mindbody staff to a sensei or a teaching manager.
// Front desk logins are not instructors. Staff ID wins; name is the CSV fallback.
export async function matchInstructor(staffId, staffName, roster = null) {
  const all = roster || await prepare("SELECT * FROM instructors WHERE role IN ('sensei', 'manager')").all();
  if (staffId) {
    const hit = all.find((i) => i.mb_staff_id && String(i.mb_staff_id) === String(staffId));
    if (hit) return hit;
  }
  if (!staffName) return null;
  let n = staffName;
  if (n.includes(',')) {
    const [last, first] = n.split(',').map((s) => s.trim());
    n = `${first} ${last}`;
  }
  const key = norm(n);
  const single = !n.trim().includes(' ');
  return all.find((i) => norm(i.mb_name) === key)
    || all.find((i) => norm(i.name) === key)
    || (single ? all.find((i) => norm((i.mb_name || i.name).split(' ')[0]) === key) : null)
    || null;
}

// Is the instructor marked away for any part of [start, end)?
export async function awayRecord(instructorId, start, end) {
  const date = start.slice(0, 10);
  const rows = await prepare(
    'SELECT * FROM unavailability WHERE instructor_id=? AND start_date<=? AND end_date>=?',
  ).all(instructorId, date, date);
  const s = toMin(start.slice(11));
  const e = toMin(end.slice(11));
  return rows.find((r) => !r.start_time || !r.end_time || (toMin(r.start_time) < e && toMin(r.end_time) > s)) || null;
}

export async function fitsWeekly(instructorId, start, end) {
  const dow = dowOf(start.slice(0, 10));
  const hours = new Set(
    (await prepare('SELECT hour FROM availability WHERE instructor_id=? AND dow=?').all(instructorId, dow)).map((r) => r.hour),
  );
  const s = toMin(start.slice(11));
  const e = toMin(end.slice(11));
  for (let h = Math.floor(s / 60); h < Math.ceil(e / 60); h++) if (!hours.has(h)) return false;
  return true;
}

export async function teachingConflict(instructor, start, end, exceptClassId = null) {
  const date = start.slice(0, 10);
  const rows = await prepare(
    'SELECT * FROM classes WHERE substr(start,1,10)=? AND cancelled=FALSE AND start<? AND "end">?',
  ).all(date, end, start);
  for (const c of rows) {
    if (c.id === exceptClassId) continue;
    const who = await matchInstructor(c.staff_id, c.staff_name);
    if (who?.id === instructor.id) return c;
  }
  const shift = await prepare(
    "SELECT * FROM shifts WHERE status='filled' AND assigned_instructor_id=? AND start<? AND \"end\">?",
  ).get(instructor.id, end, start);
  return shift || null;
}

export async function candidatesFor(shift) {
  const list = await prepare("SELECT * FROM instructors WHERE role='sensei' AND active=TRUE ORDER BY name").all();
  const out = [];
  for (const i of list) {
    if (i.id === shift.original_instructor_id) continue;
    const away = !!(await awayRecord(i.id, shift.start, shift.end));
    const busy = !!(await teachingConflict(i, shift.start, shift.end, shift.class_id));
    if (away || busy) continue;
    out.push({
      id: i.id,
      name: i.name,
      fits: await fitsWeekly(i.id, shift.start, shift.end),
      away: false,
      busy: false,
    });
  }
  out.sort((a, b) => b.fits - a.fits || a.name.localeCompare(b.name));
  return out;
}

// The cross-check. For each upcoming class that is not cancelled:
//   placeholder instructor -> open shift, reason sensei
//   instructor has overlapping time off -> open shift, reason unavailable
//   when the reason is gone, an unfilled auto shift is closed
// Filled shifts are never touched.
export async function reconcile() {
  const now = nowLocal();
  const placeholder = await placeholderName();
  const roster = await prepare("SELECT * FROM instructors WHERE role IN ('sensei', 'manager')").all();
  const classes = await prepare('SELECT * FROM classes WHERE start>=? ORDER BY start').all(now);
  const findShift = prepare("SELECT * FROM shifts WHERE class_id=? AND auto=TRUE AND status IN ('open','filled') ORDER BY id DESC LIMIT 1");
  const insert = prepare(`INSERT INTO shifts(class_id, auto, start, "end", name, location, reason, original_instructor_id, status)
    VALUES(?, TRUE, ?, ?, ?, ?, ?, ?, 'open') RETURNING id`);
  const update = prepare(`UPDATE shifts SET start=?, "end"=?, name=?, location=?, reason=?, original_instructor_id=?,
    updated_at=to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id=?`);
  const close = prepare(`UPDATE shifts SET status='closed', note=?,
    updated_at=to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id=?`);
  const withdrawClaims = prepare("UPDATE claims SET status='withdrawn' WHERE shift_id=? AND status='pending'");
  let opened = 0;
  let closed = 0;
  const openedRows = [];

  return transaction(async () => {
    for (const c of classes) {
      let reason = null;
      let original = null;
      if (!c.cancelled) {
        if (isPlaceholderNamed(c.staff_name, placeholder)) reason = 'sensei';
        else {
          const inst = await matchInstructor(c.staff_id, c.staff_name, roster);
          if (inst && await awayRecord(inst.id, c.start, c.end)) {
            reason = 'unavailable';
            original = inst.id;
          }
        }
      }
      const existing = await findShift.get(c.id);
      if (reason && !existing) {
        const row = await insert.get(c.id, c.start, c.end, c.name, c.location, reason, original);
        opened++;
        openedRows.push({
          id: row.id,
          class_id: c.id,
          start: c.start,
          end: c.end,
          name: c.name,
          location: c.location,
          reason,
          original_instructor_id: original,
        });
      } else if (reason && existing?.status === 'open') {
        await update.run(c.start, c.end, c.name, c.location, reason, original, existing.id);
      } else if (!reason && existing?.status === 'open') {
        const why = c.cancelled
          ? 'Class cancelled in Mindbody'
          : existing.reason === 'sensei'
            ? `Assigned to ${c.staff_name} in Mindbody`
            : 'Instructor is available again';
        await close.run(why, existing.id);
        await withdrawClaims.run(existing.id);
        closed++;
      }
    }
    const orphans = await prepare(`SELECT s.id FROM shifts s
      LEFT JOIN classes c ON c.id = s.class_id
      WHERE s.auto = TRUE AND s.status = 'open' AND c.id IS NULL`).all();
    for (const o of orphans) {
      await close.run('Class removed from the schedule', o.id);
      await withdrawClaims.run(o.id);
      closed++;
    }
    return { opened, closed, openedRows };
  });
}

function timeoffOverlaps(timeoff, start, end) {
  if (!timeoff.start_time || !timeoff.end_time) return true;
  return toMin(timeoff.start_time) < toMin(end.slice(11)) && toMin(timeoff.end_time) > toMin(start.slice(11));
}

// Classes this instructor teaches that this time-off record itself covers.
export async function classesCoveredBy(instructor, timeoff) {
  const rows = await prepare(
    'SELECT * FROM classes WHERE cancelled=FALSE AND substr(start,1,10)>=? AND substr(start,1,10)<=? ORDER BY start',
  ).all(timeoff.start_date, timeoff.end_date);
  const covered = [];
  for (const c of rows) {
    const who = await matchInstructor(c.staff_id, c.staff_name);
    if (who?.id !== instructor.id) continue;
    if (timeoffOverlaps(timeoff, c.start, c.end)) covered.push(c);
  }
  return covered;
}
