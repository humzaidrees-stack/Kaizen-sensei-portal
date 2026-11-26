// Mindbody Public API v6. All calls stay on the server.
// With no MB_API_KEY / MB_SITE_ID the portal runs on seeded or imported classes.
import { prepare, transaction, setSetting, getSetting } from './db.js';
import { addDays, todayLocal, reconcile } from './logic.js';

const BASE = 'https://api.mindbodyonline.com/public/v6';

export function mbConfig() {
  return {
    apiKey: process.env.MB_API_KEY || '',
    siteId: process.env.MB_SITE_ID || '',
    user: process.env.MB_USERNAME || '',
    pass: process.env.MB_PASSWORD || '',
    locations: (process.env.MB_LOCATION_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
    weeks: Number(process.env.MB_SYNC_WEEKS || 6),
  };
}

export const mbConfigured = () => !!(mbConfig().apiKey && mbConfig().siteId);
export const mbCanWrite = () => mbConfigured() && !!(mbConfig().user && mbConfig().pass);

let memoryToken = null;
let memoryTokenAt = 0;
const TOKEN_TTL = 6 * 3600e3;

async function getToken() {
  const c = mbConfig();
  if (!c.user || !c.pass) return null;
  if (memoryToken && Date.now() - memoryTokenAt < TOKEN_TTL) return memoryToken;
  const stored = await getSetting('mb_token');
  const storedAt = Number(await getSetting('mb_token_at') || 0);
  if (stored && Date.now() - storedAt < TOKEN_TTL) {
    memoryToken = stored;
    memoryTokenAt = storedAt;
    return stored;
  }
  const issued = await raw('/usertoken/issue', { method: 'POST', body: { Username: c.user, Password: c.pass } }, false);
  memoryToken = issued.AccessToken;
  memoryTokenAt = Date.now();
  await setSetting('mb_token', memoryToken);
  await setSetting('mb_token_at', String(memoryTokenAt));
  return memoryToken;
}

export function clearTokenCache() {
  memoryToken = null;
  memoryTokenAt = 0;
}

async function raw(pathname, { method = 'GET', body } = {}, auth = true) {
  const c = mbConfig();
  const headers = {
    'Api-Key': c.apiKey,
    SiteId: c.siteId,
    'Content-Type': 'application/json',
    'User-Agent': 'KaizenInstructorPortal',
  };
  if (auth) {
    const token = await getToken();
    if (token) headers.Authorization = token;
  }
  const res = await fetch(BASE + pathname, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`Mindbody ${res.status}: ${json?.Error?.Message || text.slice(0, 200)}`);
  return json;
}

const local = (s) => (s || '').slice(0, 16);
const staffName = (s) => (s ? (s.DisplayName || s.Name || [s.FirstName, s.LastName].filter(Boolean).join(' ')) : null);

async function fetchStaffMembers() {
  const out = [];
  let offset = 0;
  for (;;) {
    const r = await raw(`/staff/staff?limit=200&offset=${offset}`);
    const batch = r.StaffMembers || [];
    out.push(...batch);
    if (out.length >= (r.PaginationResponse?.TotalResults ?? 0) || !batch.length) break;
    offset += 200;
  }
  return out;
}

export async function fetchStaff() {
  const members = await fetchStaffMembers();
  return members.map((s) => ({ id: String(s.Id), name: staffName(s) }));
}

// Phones stay in this map for the PIN helper. Do not return them from an API route or write them to the database.
export async function fetchStaffPhones() {
  const members = await fetchStaffMembers();
  const phones = {};
  for (const s of members) {
    if (s?.Id == null) continue;
    phones[String(s.Id)] = String(s.MobilePhone || s.HomePhone || s.WorkPhone || '').trim();
  }
  return phones;
}

export async function syncClasses() {
  const c = mbConfig();
  const start = todayLocal();
  const end = addDays(start, c.weeks * 7);
  const classes = [];
  let offset = 0;
  for (;;) {
    const q = new URLSearchParams({
      StartDateTime: `${start}T00:00:00`,
      EndDateTime: `${end}T23:59:59`,
      Limit: '200',
      Offset: String(offset),
    });
    c.locations.forEach((l) => q.append('LocationIds', l));
    const r = await raw(`/class/classes?${q}`);
    const batch = r.Classes || [];
    classes.push(...batch);
    if (classes.length >= (r.PaginationResponse?.TotalResults ?? 0) || !batch.length) break;
    offset += 200;
  }
  await transaction(async () => {
    await prepare('DELETE FROM classes WHERE substr(start,1,10)>=? AND substr(start,1,10)<=?').run(start, end);
    const up = prepare(`INSERT INTO classes(id, start, "end", name, staff_id, staff_name, location, booked, capacity, cancelled, source, synced_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,'mindbody', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
      ON CONFLICT(id) DO UPDATE SET start=EXCLUDED.start, "end"=EXCLUDED."end", name=EXCLUDED.name,
        staff_id=EXCLUDED.staff_id, staff_name=EXCLUDED.staff_name, location=EXCLUDED.location,
        booked=EXCLUDED.booked, capacity=EXCLUDED.capacity, cancelled=EXCLUDED.cancelled,
        source='mindbody', synced_at=EXCLUDED.synced_at`);
    for (const k of classes) {
      await up.run(
        String(k.Id),
        local(k.StartDateTime),
        local(k.EndDateTime),
        k.ClassDescription?.Name || 'Class',
        k.Staff?.Id != null ? String(k.Staff.Id) : null,
        staffName(k.Staff),
        k.Location?.Name || null,
        k.TotalBooked ?? null,
        k.MaxCapacity ?? null,
        !!k.IsCanceled,
      );
    }
  });
  await setSetting('last_sync', new Date().toISOString());
  await setSetting('schedule_source', 'mindbody');
  // Classes that arrive inside leave already on file are opened here, even when
  // the leave was booked before this sync window included them.
  return { classes: classes.length, ...(await reconcile()) };
}

// Schedule fields only. Client lists on the Mindbody payload are ignored.
export function historyRowFromMindbody(k) {
  return {
    id: String(k.Id),
    start: local(k.StartDateTime),
    end: local(k.EndDateTime),
    name: k.ClassDescription?.Name || 'Class',
    staffId: k.Staff?.Id != null ? String(k.Staff.Id) : null,
    staffName: staffName(k.Staff),
    location: k.Location?.Name || null,
    locationId: k.Location?.Id != null ? String(k.Location.Id) : null,
    classScheduleId: k.ClassScheduleId != null ? String(k.ClassScheduleId) : null,
    classDescriptionId: k.ClassDescription?.Id != null ? String(k.ClassDescription.Id) : null,
    resourceId: k.Resource?.Id != null ? String(k.Resource.Id) : null,
    capacity: k.MaxCapacity ?? null,
    webCapacity: k.WebCapacity ?? null,
    waitlistCapacity: k.WaitlistCapacity ?? null,
    bookingStatus: k.BookingStatus || null,
    staffPayRate: k.StaffPayRate ?? null,
    booked: k.TotalBooked ?? null,
    cancelled: !!k.IsCanceled,
  };
}

async function fetchClassesBetween(start, end) {
  const c = mbConfig();
  const classes = [];
  let offset = 0;
  for (;;) {
    const q = new URLSearchParams({
      StartDateTime: `${start}T00:00:00`,
      EndDateTime: `${end}T23:59:59`,
      Limit: '200',
      Offset: String(offset),
    });
    c.locations.forEach((l) => q.append('LocationIds', l));
    const r = await raw(`/class/classes?${q}`);
    const batch = r.Classes || [];
    classes.push(...batch);
    if (classes.length >= (r.PaginationResponse?.TotalResults ?? 0) || !batch.length) break;
    offset += 200;
  }
  return classes;
}

// Read-only. Replaces class_history rows in the date range. Does not touch classes or Mindbody.
export async function importClassHistory(start, end) {
  const classes = await fetchClassesBetween(start, end);
  const rows = classes.map(historyRowFromMindbody);
  await transaction(async () => {
    await prepare('DELETE FROM class_history WHERE substr(start,1,10) BETWEEN ? AND ?').run(start, end);
    const ins = prepare(`INSERT INTO class_history(
      id, start, "end", name, staff_id, staff_name, location, location_id, class_schedule_id,
      class_description_id, resource_id, capacity, web_capacity, waitlist_capacity, booking_status,
      staff_pay_rate, booked, cancelled
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET start=EXCLUDED.start, "end"=EXCLUDED."end", name=EXCLUDED.name,
      staff_id=EXCLUDED.staff_id, staff_name=EXCLUDED.staff_name, location=EXCLUDED.location,
      location_id=EXCLUDED.location_id, class_schedule_id=EXCLUDED.class_schedule_id,
      class_description_id=EXCLUDED.class_description_id, resource_id=EXCLUDED.resource_id,
      capacity=EXCLUDED.capacity, web_capacity=EXCLUDED.web_capacity,
      waitlist_capacity=EXCLUDED.waitlist_capacity, booking_status=EXCLUDED.booking_status,
      staff_pay_rate=EXCLUDED.staff_pay_rate, booked=EXCLUDED.booked, cancelled=EXCLUDED.cancelled,
      synced_at=to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`);
    for (const row of rows) {
      await ins.run(
        row.id, row.start, row.end, row.name, row.staffId, row.staffName, row.location, row.locationId,
        row.classScheduleId, row.classDescriptionId, row.resourceId, row.capacity, row.webCapacity,
        row.waitlistCapacity, row.bookingStatus, row.staffPayRate, row.booked, row.cancelled,
      );
    }
  });
  return { classes: rows.length, from: start, to: end };
}

// POST /class/substituteclassteacher — payroll follows the instructor who covers.
// Cover shifts still email the substitute teacher. Draft publish uses pushScheduleTeacher instead.
export async function pushSubstitute(classId, staffId) {
  return raw('/class/substituteclassteacher', {
    method: 'POST',
    body: {
      ClassId: Number(classId),
      StaffId: Number(staffId),
      OverrideConflicts: false,
      SendClientEmail: false,
      SendOriginalTeacherEmail: false,
      SendSubstituteTeacherEmail: true,
    },
  });
}

// Teacher change for a class that already exists. Every Mindbody email stays off.
export async function pushScheduleTeacher(classId, staffId) {
  return raw('/class/substituteclassteacher', {
    method: 'POST',
    body: {
      ClassId: Number(classId),
      StaffId: Number(staffId),
      OverrideConflicts: false,
      SendClientEmail: false,
      SendOriginalTeacherEmail: false,
      SendSubstituteTeacherEmail: false,
    },
  });
}

// Staff id and name only. The rest of the class payload, including any client list, is dropped.
export async function readClassTeacher(classId) {
  const q = new URLSearchParams({ ClassIds: String(classId) });
  const body = await raw(`/class/classes?${q}`);
  const cls = (body.Classes || []).find((row) => String(row.Id) === String(classId));
  if (!cls?.Staff) return null;
  const staff = cls.Staff;
  return {
    staffId: staff.Id == null ? null : String(staff.Id),
    staffName: staff.DisplayName || staff.Name || [staff.FirstName, staff.LastName].filter(Boolean).join(' ') || null,
  };
}
