// Session and PIN login.
// Mindbody staff login (D7) can replace PIN login later: issue a staff user token,
// read the staff id, and call createSessionForInstructor for the linked row.
// The browser still only holds our session cookie. Mindbody credentials stay on the server.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { prepare } from './db.js';

export const ROLES = ['sensei', 'front_desk', 'manager'];
const SESSION_DAYS = 30;
const LOCK_AFTER = 6;
const LOCK_MS = 15 * 60 * 1000;

let dummyHash = null;
function dummyPinHash() {
  if (!dummyHash) dummyHash = hashPin('not-a-real-pin');
  return dummyHash;
}

export function hashPin(pin) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(String(pin), salt, 32).toString('hex')}`;
}

export function checkPin(pin, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  try {
    const test = scryptSync(String(pin), Buffer.from(salt, 'hex'), 32);
    const expected = Buffer.from(hash, 'hex');
    if (test.length !== expected.length) return false;
    return timingSafeEqual(test, expected);
  } catch {
    return false;
  }
}

export const newPin = () => String(100000 + (randomBytes(4).readUInt32BE() % 900000));

export function publicUser(i) {
  if (!i) return null;
  return {
    id: i.id,
    code: i.code,
    name: i.name,
    role: i.role,
    // Managers are the reference app's "admin". Front desk is not.
    is_admin: i.role === 'manager',
    mb_staff_id: i.mb_staff_id,
    mb_name: i.mb_name,
    active: !!i.active,
    must_change_pin: !!i.must_change_pin,
    last_login_at: i.last_login_at ? new Date(i.last_login_at).toISOString() : null,
  };
}

export function pinFromPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 4) return null;
  return digits.slice(-4);
}

function nameWords(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function canTeach(user) {
  return user?.role === 'sensei' || user?.role === 'manager';
}

export function canDesk(user) {
  return user?.role === 'front_desk' || user?.role === 'manager';
}

export function isManager(user) {
  return user?.role === 'manager';
}

const millis = () => Date.now().toString();

export async function loadUserByToken(token) {
  if (!token) return null;
  return prepare(`SELECT i.* FROM sessions s
    JOIN instructors i ON i.id = s.instructor_id
    WHERE s.token=? AND s.expires_at>? AND i.active=TRUE`).get(token, millis()) || null;
}

export async function createSession(instructorId) {
  const token = randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_DAYS * 864e5;
  await prepare('INSERT INTO sessions(token, instructor_id, expires_at) VALUES(?,?,?)').run(token, instructorId, String(expires));
  await prepare('DELETE FROM sessions WHERE expires_at<?').run(millis());
  return token;
}

export async function destroySession(token) {
  if (token) await prepare('DELETE FROM sessions WHERE token=?').run(token);
}

// Future Mindbody staff login: look up the linked instructor and open our session.
export async function createSessionForStaff(staffId) {
  if (!staffId) return null;
  const user = await prepare(
    "SELECT * FROM instructors WHERE mb_staff_id=? AND active=TRUE AND role IN ('sensei','manager','front_desk')",
  ).get(String(staffId));
  if (!user) return null;
  const token = await createSession(user.id);
  return { token, user };
}

export function sessionCookie(token, { maxAge = SESSION_DAYS * 86400 } = {}) {
  const parts = [`kp_s=${token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${maxAge}`];
  if (process.env.COOKIE_SECURE === '1') parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie() {
  const parts = ['kp_s=', 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (process.env.COOKIE_SECURE === '1') parts.push('Secure');
  return parts.join('; ');
}

export async function loginLocked(code) {
  const row = await prepare('SELECT failures, locked_until FROM login_attempts WHERE code=?').get(code);
  return !!(row?.locked_until && Number(row.locked_until) > Date.now());
}

export async function recordLoginFailure(code) {
  const row = await prepare('SELECT failures, locked_until FROM login_attempts WHERE code=?').get(code);
  let failures = (row?.failures || 0) + 1;
  if (row?.locked_until && Number(row.locked_until) <= Date.now()) failures = 1;
  const lockedUntil = failures >= LOCK_AFTER ? String(Date.now() + LOCK_MS) : null;
  await prepare(`INSERT INTO login_attempts(code, failures, locked_until) VALUES(?,?,?)
    ON CONFLICT(code) DO UPDATE SET failures=EXCLUDED.failures, locked_until=EXCLUDED.locked_until`)
    .run(code, failures, lockedUntil);
}

export async function clearLoginFailures(code) {
  await prepare('DELETE FROM login_attempts WHERE code=?').run(code);
}

// Always runs a hash compare so a missing user does not return faster.
export async function verifyLogin(code, pin) {
  const key = String(code || '').trim().toUpperCase();
  if (await loginLocked(key)) {
    return { ok: false, status: 429, error: 'Too many attempts. Try again in 15 minutes.' };
  }
  const user = key
    ? await prepare('SELECT * FROM instructors WHERE UPPER(code)=? AND active=TRUE').get(key)
    : null;
  const match = checkPin(String(pin || '').trim(), user?.pin_hash || dummyPinHash());
  if (!user || !match) {
    if (key) await recordLoginFailure(key);
    return { ok: false, status: 401, error: 'That ID and PIN do not match.' };
  }
  await clearLoginFailures(key);
  const stamped = await prepare('UPDATE instructors SET last_login_at=NOW() WHERE id=? RETURNING last_login_at').get(user.id);
  user.last_login_at = stamped?.last_login_at || null;
  const token = await createSession(user.id);
  return { ok: true, token, user };
}

// First name plus the first letter of the surname: "Gaby Lee" -> GABYL, "Dézi Olle" -> DEZIO.
// If that ID is taken, use more of the surname, then a digit. ADMIN and DESK are never generated here.
export async function nextCode(name) {
  const words = nameWords(name);
  const first = words[0] || 'SENSEI';
  const surname = words.length > 1 ? words[words.length - 1] : '';
  const stems = [];
  if (surname) {
    for (let i = 1; i <= surname.length; i++) stems.push(first + surname.slice(0, i));
  } else {
    stems.push(first);
  }
  const taken = async (code) => !!(await prepare('SELECT 1 FROM instructors WHERE UPPER(code)=?').get(code));
  for (const stem of stems) {
    const code = stem.slice(0, 20);
    if (code.length >= 3 && !(await taken(code))) return code;
  }
  let stem = (stems[stems.length - 1] || 'SENSEI').slice(0, 18);
  while (stem.length < 2) stem += '2';
  for (let n = 2; n < 100; n++) {
    const code = `${stem}${n}`.slice(0, 20);
    if (code.length >= 3 && !(await taken(code))) return code;
  }
  throw new Error('Could not assign a login ID');
}
