import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, makeClass } from './helpers.js';
import { closePool } from '../src/db.js';
import {
  reconcile, awayRecord, fitsWeekly, teachingConflict, candidatesFor, matchInstructor,
  addDays, todayLocal, placeholderName,
} from '../src/logic.js';
import { prepare, setSetting } from '../src/db.js';

const day = () => addDays(todayLocal(), 9);

describe('scheduling rules', { concurrency: 1 }, () => {
  before(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });
  after(async () => { await closePool(); });

  it('opens a shift when the instructor is the Kaizen Sensei placeholder', async () => {
    const date = day();
    await makeClass({ id: 'c1', start: `${date}T15:00`, end: `${date}T15:50`, name: 'Active Sculpt', staffName: 'Kaizen Sensei' });
    const result = await reconcile();
    assert.equal(result.opened, 1);
    assert.equal(result.openedRows[0].reason, 'sensei');
    const shift = await prepare("SELECT * FROM shifts WHERE class_id='c1'").get();
    assert.equal(shift.status, 'open');
    assert.equal(shift.reason, 'sensei');
  });

  it('opens a shift when time off overlaps a class, and not when it misses', async () => {
    const date = day();
    const sensei = await makeUser({ code: 'KP201', name: 'Christina Sagawe', mbName: 'Christina Sagawe' });
    await makeClass({ id: 'am', start: `${date}T10:00`, end: `${date}T10:50`, name: 'Gentle Flow', staffName: 'Christina' });
    await makeClass({ id: 'pm', start: `${date}T18:00`, end: `${date}T18:50`, name: 'Power Surge', staffName: 'Christina Sagawe' });
    await prepare('INSERT INTO unavailability(instructor_id, start_date, end_date, start_time, end_time) VALUES(?,?,?,?,?)')
      .run(sensei.id, date, date, '10:00', '11:00');
    const result = await reconcile();
    assert.equal(result.opened, 1);
    const open = await prepare('SELECT class_id, reason, original_instructor_id FROM shifts WHERE status=\'open\'').all();
    assert.deepEqual(open.map((s) => s.class_id), ['am']);
    assert.equal(open[0].reason, 'unavailable');
    assert.equal(open[0].original_instructor_id, sensei.id);
  });

  it('closes an open cover shift when the time off is removed, and leaves a filled one', async () => {
    const date = day();
    const sensei = await makeUser({ code: 'KP202', name: 'Dezi Olle' });
    const cover = await makeUser({ code: 'KP203', name: 'Claudia Guerra Cafoncelli' });
    await makeClass({ id: 'a', start: `${date}T12:00`, end: `${date}T12:50`, name: 'Core Power', staffName: 'Dezi' });
    await makeClass({ id: 'b', start: `${date}T13:00`, end: `${date}T13:50`, name: 'Gentle Flow', staffName: 'Dezi Olle' });
    const off = await prepare('INSERT INTO unavailability(instructor_id, start_date, end_date, note) VALUES(?,?,?,?) RETURNING id')
      .get(sensei.id, date, date, 'Leave');
    await reconcile();
    const filled = await prepare("SELECT id FROM shifts WHERE class_id='b'").get();
    await prepare("UPDATE shifts SET status='filled', assigned_instructor_id=? WHERE id=?").run(cover.id, filled.id);
    await prepare('DELETE FROM unavailability WHERE id=?').run(off.id);
    const result = await reconcile();
    assert.equal(result.closed, 1);
    const a = await prepare("SELECT status, note FROM shifts WHERE class_id='a'").get();
    const b = await prepare("SELECT status, assigned_instructor_id FROM shifts WHERE class_id='b'").get();
    assert.equal(a.status, 'closed');
    assert.equal(a.note, 'Instructor is available again');
    assert.equal(b.status, 'filled');
    assert.equal(b.assigned_instructor_id, cover.id);
  });

  it('closes a placeholder shift once Mindbody has a real instructor, including a cancelled class', async () => {
    const date = day();
    await makeClass({ id: 'p', start: `${date}T15:00`, end: `${date}T15:50`, name: 'Active Sculpt', staffName: 'Kaizen Sensei' });
    await makeClass({ id: 'x', start: `${date}T16:00`, end: `${date}T16:50`, name: 'Deep Release', staffName: 'Kaizen Sensei' });
    await reconcile();
    await prepare("UPDATE classes SET staff_name='Venus Ng' WHERE id='p'").run();
    await prepare("UPDATE classes SET cancelled=TRUE WHERE id='x'").run();
    const result = await reconcile();
    assert.equal(result.closed, 2);
    assert.equal(result.opened, 0);
    const p = await prepare("SELECT status, note FROM shifts WHERE class_id='p'").get();
    const x = await prepare("SELECT note FROM shifts WHERE class_id='x'").get();
    assert.equal(p.status, 'closed');
    assert.match(p.note, /Assigned to Venus Ng/);
    assert.match(x.note, /cancelled/i);
  });

  it('closes an open auto shift whose class has disappeared', async () => {
    const date = day();
    await makeClass({ id: 'gone', start: `${date}T09:00`, end: `${date}T09:50`, name: 'Core Power', staffName: 'Kaizen Sensei' });
    await reconcile();
    await prepare("DELETE FROM classes WHERE id='gone'").run();
    const result = await reconcile();
    assert.equal(result.closed, 1);
    const shift = await prepare("SELECT status, note FROM shifts WHERE class_id='gone'").get();
    assert.equal(shift.status, 'closed');
    assert.match(shift.note, /removed/);
  });

  it('matches staff id first, then Mindbody "Last, First" names', async () => {
    const byId = await makeUser({ code: 'KP204', name: 'Wrong Name', mbName: 'Someone Else', mbStaffId: '55' });
    const byName = await makeUser({ code: 'KP205', name: 'Venus Ng', mbName: 'Venus Ng' });
    const idHit = await matchInstructor('55', 'Venus Ng');
    assert.equal(idHit.id, byId.id);
    const nameHit = await matchInstructor(null, 'Ng, Venus');
    assert.equal(nameHit.id, byName.id);
    assert.equal(await matchInstructor(null, 'Kaizen Sensei'), null);
  });

  it('treats weekly availability, time off and teaching conflicts as the reference does', async () => {
    const date = day();
    const sensei = await makeUser({ code: 'KP206', name: 'Natacha Benbernou' });
    const other = await makeUser({ code: 'KP207', name: 'Jaime Cooke' });
    await prepare('INSERT INTO availability(instructor_id, dow, hour) VALUES(?,?,?)').run(sensei.id, (new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7, 9);
    assert.equal(await fitsWeekly(sensei.id, `${date}T09:00`, `${date}T09:50`), true);
    assert.equal(await fitsWeekly(sensei.id, `${date}T10:00`, `${date}T10:50`), false);
    await prepare('INSERT INTO unavailability(instructor_id, start_date, end_date, start_time, end_time) VALUES(?,?,?,?,?)')
      .run(other.id, date, date, '18:00', '19:00');
    assert.ok(await awayRecord(other.id, `${date}T18:10`, `${date}T18:40`));
    assert.equal(await awayRecord(other.id, `${date}T17:00`, `${date}T17:50`), null);
    await makeClass({ id: 'busy', start: `${date}T09:00`, end: `${date}T09:50`, name: 'Gentle Flow', staffName: 'Natacha' });
    const clash = await teachingConflict(sensei, `${date}T09:15`, `${date}T10:00`, 'other-class');
    assert.equal(clash.id, 'busy');
    assert.equal(await teachingConflict(sensei, `${date}T09:15`, `${date}T10:00`, 'busy'), null);
  });

  it('offers free colleagues inside their hours first, and never the original instructor', async () => {
    const date = day();
    const away = await makeUser({ code: 'KP208', name: 'Iona de Maudesley' });
    const fit = await makeUser({ code: 'KP209', name: 'Gaby Lee' });
    const free = await makeUser({ code: 'KP210', name: 'Fiona Marie' });
    const dow = (new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7;
    await prepare('INSERT INTO availability(instructor_id, dow, hour) VALUES(?,?,?)').run(fit.id, dow, 8);
    await prepare('INSERT INTO unavailability(instructor_id, start_date, end_date) VALUES(?,?,?)').run(away.id, date, date);
    await makeClass({ id: 'cover-me', start: `${date}T08:00`, end: `${date}T08:50`, name: 'Peach Perfect', staffName: 'Iona' });
    await reconcile();
    const shift = await prepare("SELECT * FROM shifts WHERE class_id='cover-me'").get();
    const names = (await candidatesFor(shift)).map((c) => c.name);
    assert.deepEqual(names, ['Gaby Lee', 'Fiona Marie']);
    assert.equal((await candidatesFor(shift))[0].fits, true);
    assert.equal((await candidatesFor(shift))[1].fits, false);
  });

  it('uses the configured placeholder name', async () => {
    await setSetting('placeholder_name', 'Cover Needed');
    assert.equal(await placeholderName(), 'Cover Needed');
    const date = day();
    await makeClass({ id: 'ph', start: `${date}T11:00`, end: `${date}T11:50`, name: 'Core Power', staffName: 'Cover Needed' });
    const result = await reconcile();
    assert.equal(result.openedRows[0].reason, 'sensei');
  });
});
