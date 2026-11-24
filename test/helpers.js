import { migrate } from '../db/migrate.js';
import { prepare } from '../src/db.js';
import { hashPin } from '../src/auth.js';

export async function resetDb() {
  await migrate();
  await prepare(`TRUNCATE alerts, claims, shifts, classes, class_history, schedule_draft_slots, schedule_drafts, unavailability, availability, sessions, login_attempts, instructors, settings RESTART IDENTITY CASCADE`).run();
}

export async function makeUser({ code, name, role = 'sensei', pin = '1234', mbStaffId = null, mbName = null }) {
  const row = await prepare(`INSERT INTO instructors(code, name, mb_name, mb_staff_id, pin_hash, role)
    VALUES(?,?,?,?,?,?) RETURNING *`).get(code, name, mbName || name, mbStaffId, hashPin(pin), role);
  return row;
}

export async function makeClass({ id, start, end, name, staffName, staffId = null, location = 'Kaizen Saadiyat', cancelled = false, source = 'demo' }) {
  await prepare(`INSERT INTO classes(id, start, "end", name, staff_id, staff_name, location, cancelled, source)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(id, start, end, name, staffId, staffName, location, cancelled, source);
}
