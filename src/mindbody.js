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
  return { classes: classes.length, ...(await reconcile()) };
}

// POST /class/substituteclassteacher — payroll follows the instructor who covers.
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
