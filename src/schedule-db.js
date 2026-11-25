// Load schedule rows and store drafts. Reads classes and class_history.
// Does not call Mindbody.
import { prepare, transaction } from './db.js';
import { addDays, todayLocal } from './logic.js';
import {
  assignDraft, buildMonthDraft, explainUnfilled, hoursCover, matchSensei, monthRange,
  monthsForFifteenth, normName, previousMonth, publishDecision, summarizeDraft, weekStart,
  PLACEHOLDER_NAME,
} from './schedule.js';
import { dowOf } from './logic.js';

const STAMP = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`;

export function isConfirmed(row) {
  if (!row?.availability_confirmed_at) return false;
  if (row.availability_prefilled_at && row.availability_confirmed_at < row.availability_prefilled_at) return false;
  return true;
}

function classFromLive(row) {
  return {
    id: row.id,
    start: row.start.slice(0, 16),
    end: row.end.slice(0, 16),
    name: row.name,
    staffId: row.staff_id || null,
    staffName: row.staff_name || null,
    location: row.location || null,
    cancelled: !!row.cancelled,
    booked: row.booked ?? null,
    capacity: row.capacity ?? null,
    locationId: null,
    classDescriptionId: null,
    resourceId: null,
    webCapacity: null,
    waitlistCapacity: null,
    bookingStatus: null,
    staffPayRate: null,
    classScheduleId: null,
  };
}

function classFromHistory(row) {
  return {
    id: row.id,
    start: row.start.slice(0, 16),
    end: row.end.slice(0, 16),
    name: row.name,
    staffId: row.staff_id || null,
    staffName: row.staff_name || null,
    location: row.location || null,
    cancelled: !!row.cancelled,
    booked: row.booked ?? null,
    capacity: row.capacity ?? null,
    locationId: row.location_id || null,
    classDescriptionId: row.class_description_id || null,
    resourceId: row.resource_id || null,
    webCapacity: row.web_capacity ?? null,
    waitlistCapacity: row.waitlist_capacity ?? null,
    bookingStatus: row.booking_status || null,
    staffPayRate: row.staff_pay_rate ?? null,
    classScheduleId: row.class_schedule_id || null,
  };
}

function overlay(base, over) {
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

async function classesBetween(start, end) {
  const live = (await prepare(
    'SELECT * FROM classes WHERE substr(start,1,10) BETWEEN ? AND ?',
  ).all(start, end)).map(classFromLive);
  const history = (await prepare(
    'SELECT * FROM class_history WHERE substr(start,1,10) BETWEEN ? AND ?',
  ).all(start, end)).map(classFromHistory);
  const merged = new Map();
  for (const row of history) merged.set(row.id, row);
  for (const row of live) merged.set(row.id, overlay(merged.get(row.id) || {}, row));
  return [...merged.values()];
}

async function loadPeople() {
  const rows = await prepare("SELECT * FROM instructors WHERE role='sensei' AND active=TRUE ORDER BY name").all();
  const blocks = await prepare('SELECT instructor_id, dow, hour FROM availability').all();
  const hours = new Map();
  for (const block of blocks) {
    if (!hours.has(block.instructor_id)) hours.set(block.instructor_id, new Set());
    hours.get(block.instructor_id).add(`${block.dow}-${block.hour}`);
  }
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    mbName: row.mb_name || null,
    mbStaffId: row.mb_staff_id || null,
    active: !!row.active,
    confirmed: isConfirmed(row),
    hours: hours.get(row.id) || new Set(),
  }));
}

async function loadTimeoff(start, end) {
  const rows = await prepare(
    'SELECT * FROM unavailability WHERE end_date>=? AND start_date<=?',
  ).all(start, end);
  return rows.map((row) => ({
    instructorId: row.instructor_id,
    startDate: row.start_date,
    endDate: row.end_date,
    startTime: row.start_time || null,
    endTime: row.end_time || null,
  }));
}

function slotToRow(slot) {
  return {
    slot_date: slot.date || slot.start.slice(0, 10),
    start: slot.start.slice(0, 16),
    end: slot.end.slice(0, 16),
    name: slot.name,
    location: slot.location,
    class_id: slot.classId || null,
    class_description_id: slot.classDescriptionId || null,
    location_id: slot.locationId || null,
    class_schedule_id: slot.classScheduleId || null,
    resource_id: slot.resourceId || null,
    staff_pay_rate: slot.staffPayRate ?? null,
    max_capacity: slot.maxCapacity ?? null,
    web_capacity: slot.webCapacity ?? null,
    waitlist_capacity: slot.waitlistCapacity ?? null,
    booking_status: slot.bookingStatus || null,
    current_staff_id: slot.currentStaffId || null,
    current_staff_name: slot.currentStaffName || null,
    proposed_instructor_id: slot.proposedInstructorId || null,
    reason: slot.reason,
    kind: slot.kind,
    removed: !!slot.removed,
    pinned: !!slot.pinned,
    booked: slot.booked ?? null,
    eligible_ids: JSON.stringify(slot.eligibleIds || []),
  };
}

function rowToSlot(row) {
  return {
    id: row.id,
    draftId: row.draft_id,
    date: row.slot_date,
    start: row.start,
    end: row.end,
    name: row.name,
    location: row.location,
    classId: row.class_id,
    classDescriptionId: row.class_description_id,
    locationId: row.location_id,
    classScheduleId: row.class_schedule_id,
    resourceId: row.resource_id,
    staffPayRate: row.staff_pay_rate,
    maxCapacity: row.max_capacity,
    webCapacity: row.web_capacity,
    waitlistCapacity: row.waitlist_capacity,
    bookingStatus: row.booking_status,
    currentStaffId: row.current_staff_id,
    currentStaffName: row.current_staff_name,
    proposedInstructorId: row.proposed_instructor_id,
    reason: row.reason,
    kind: row.kind,
    removed: !!row.removed,
    pinned: !!row.pinned,
    booked: row.booked,
    eligibleIds: Array.isArray(row.eligible_ids) ? row.eligible_ids : JSON.parse(row.eligible_ids || '[]'),
  };
}

async function contextFor(draft) {
  const instructors = await loadPeople();
  const timeoff = await loadTimeoff(draft.pattern_start < draft.target_start ? draft.pattern_start : draft.target_start, draft.target_end);
  const patternClasses = await classesBetween(draft.pattern_start, draft.pattern_end);
  const targetClasses = await classesBetween(draft.target_start, draft.target_end);
  const aroundStart = weekStart(draft.target_start);
  const aroundEnd = addDays(weekStart(draft.target_end), 6);
  const around = await classesBetween(aroundStart, aroundEnd);
  const targetIds = new Set(targetClasses.map((c) => c.id));
  const fixedClasses = around.filter((c) => !c.cancelled && !targetIds.has(c.id));
  return { instructors, timeoff, patternClasses, targetClasses, fixedClasses };
}

async function insertSlots(draftId, slots) {
  const ins = prepare(`INSERT INTO schedule_draft_slots(
    draft_id, slot_date, start, "end", name, location, class_id, class_description_id, location_id,
    class_schedule_id, resource_id, staff_pay_rate, max_capacity, web_capacity, waitlist_capacity,
    booking_status, current_staff_id, current_staff_name, proposed_instructor_id, reason, kind,
    removed, pinned, booked, eligible_ids
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?::jsonb)`);
  for (const slot of slots) {
    const row = slotToRow(slot);
    await ins.run(
      draftId, row.slot_date, row.start, row.end, row.name, row.location, row.class_id,
      row.class_description_id, row.location_id, row.class_schedule_id, row.resource_id,
      row.staff_pay_rate, row.max_capacity, row.web_capacity, row.waitlist_capacity, row.booking_status,
      row.current_staff_id, row.current_staff_name, row.proposed_instructor_id, row.reason, row.kind,
      row.removed, row.pinned, row.booked, row.eligible_ids,
    );
  }
}

async function writeAssignments(slots) {
  const upd = prepare(`UPDATE schedule_draft_slots
    SET proposed_instructor_id=?, reason=?, pinned=?, removed=?, eligible_ids=?::jsonb
    WHERE id=?`);
  for (const slot of slots) {
    if (!slot.id) continue;
    await upd.run(
      slot.proposedInstructorId || null,
      slot.reason,
      !!slot.pinned,
      !!slot.removed,
      JSON.stringify(slot.eligibleIds || []),
      slot.id,
    );
  }
}

export async function getDraftRow(id) {
  return prepare('SELECT * FROM schedule_drafts WHERE id=?').get(id);
}

export async function slotsFor(draftId) {
  const rows = await prepare('SELECT * FROM schedule_draft_slots WHERE draft_id=? ORDER BY start, name, id').all(draftId);
  return rows.map(rowToSlot);
}

function publicSlot(slot, instructors) {
  const teacher = instructors.find((i) => i.id === slot.proposedInstructorId);
  const options = (slot.eligibleIds || [])
    .map((id) => instructors.find((i) => i.id === id))
    .filter(Boolean)
    .map((i) => ({ id: i.id, name: i.name }));
  return {
    id: slot.id,
    date: slot.date,
    start: slot.start,
    end: slot.end,
    name: slot.name,
    location: slot.location,
    kind: slot.kind,
    removed: slot.removed,
    pinned: slot.pinned,
    classId: slot.classId,
    currentStaffName: slot.currentStaffName,
    proposedInstructorId: slot.proposedInstructorId,
    proposedName: teacher?.name || (slot.kind === 'extra' ? slot.currentStaffName : (slot.removed ? null : PLACEHOLDER_NAME)),
    reason: slot.reason,
    booked: slot.booked,
    options,
  };
}

export async function presentDraft(draft, host) {
  const slots = await slotsFor(draft.id);
  const instructors = await loadPeople();
  const gate = publishDecision({ flag: process.env.MB_SCHEDULE_PUBLISH, host: String(host || '').split(':')[0] });
  return {
    ready: true,
    draft: {
      id: draft.id,
      location: draft.location,
      targetStart: draft.target_start,
      targetEnd: draft.target_end,
      patternStart: draft.pattern_start,
      patternEnd: draft.pattern_end,
      status: draft.status,
      source: draft.source,
      slots: slots.map((slot) => publicSlot(slot, instructors)),
    },
    diff: summarizeDraft(slots, instructors),
    publish: gate,
  };
}

export async function findOpenDraft(location, targetStart) {
  return prepare(
    "SELECT * FROM schedule_drafts WHERE location=? AND target_start=? AND status='draft' ORDER BY id DESC LIMIT 1",
  ).get(location, targetStart);
}

export async function createDraft({ location, month, createdBy = null, source = 'manual' }) {
  const [year, mon] = month.split('-').map(Number);
  const target = monthRange(year, mon);
  const pattern = previousMonth(month);
  const open = await findOpenDraft(location, target.start);
  if (open) return open;
  const shell = {
    location,
    pattern_start: pattern.start,
    pattern_end: pattern.end,
    target_start: target.start,
    target_end: target.end,
  };
  const ctx = await contextFor(shell);
  const patternHere = ctx.patternClasses.filter((c) => c.location && c.location.toLowerCase() === location.toLowerCase() && !c.cancelled);
  if (!patternHere.length && source === 'fifteenth') return null;
  const built = buildMonthDraft({
    patternClasses: ctx.patternClasses,
    targetClasses: ctx.targetClasses,
    instructors: ctx.instructors,
    timeoff: ctx.timeoff,
    fixedClasses: ctx.fixedClasses,
    location,
    targetStart: target.start,
    targetEnd: target.end,
    patternStart: pattern.start,
    patternEnd: pattern.end,
  });
  const slots = built.slots;
  return transaction(async () => {
    const again = await findOpenDraft(location, target.start);
    if (again) return again;
    const draft = await prepare(`INSERT INTO schedule_drafts(
      location, target_start, target_end, pattern_start, pattern_end, created_by, source
    ) VALUES(?,?,?,?,?,?,?) RETURNING *`).get(
      location, target.start, target.end, pattern.start, pattern.end, createdBy, source,
    );
    await insertSlots(draft.id, slots);
    return draft;
  });
}

async function recompute(draft) {
  const ctx = await contextFor(draft);
  const slots = await slotsFor(draft.id);
  const assigned = assignDraft(slots, ctx);
  await writeAssignments(assigned);
}

export async function addSlot(draft, { date, start, end, name }) {
  if (date < draft.target_start || date > draft.target_end) {
    const err = new Error('Pick a date inside the draft month.');
    err.status = 400;
    throw err;
  }
  const slot = {
    date,
    start: `${date}T${start}`,
    end: `${date}T${end}`,
    name: name.trim(),
    location: draft.location,
    kind: 'added',
    classId: null,
    currentStaffId: null,
    currentStaffName: PLACEHOLDER_NAME,
    booked: null,
    removed: false,
    pinned: false,
    proposedInstructorId: null,
    reason: 'Added class.',
  };
  await transaction(async () => {
    await insertSlots(draft.id, [slot]);
    await prepare(`UPDATE schedule_drafts SET updated_at=${STAMP} WHERE id=?`).run(draft.id);
  });
  await recompute(draft);
}

export async function removeSlot(draft, slotId) {
  const slot = await prepare('SELECT * FROM schedule_draft_slots WHERE id=? AND draft_id=?').get(slotId, draft.id);
  if (!slot) {
    const err = new Error('That class is not on this draft.');
    err.status = 400;
    throw err;
  }
  await prepare(`UPDATE schedule_draft_slots
    SET removed=TRUE, pinned=FALSE, proposed_instructor_id=NULL,
      reason='Removed. A later step would cancel this class in Mindbody.'
    WHERE id=?`).run(slot.id);
  await recompute(draft);
}

export async function pinSlot(draft, slotId, instructorId) {
  const slot = await prepare('SELECT * FROM schedule_draft_slots WHERE id=? AND draft_id=?').get(slotId, draft.id);
  if (!slot || slot.removed || slot.kind === 'extra') {
    const err = new Error('That class cannot be reassigned.');
    err.status = 400;
    throw err;
  }
  const people = await loadPeople();
  const teacher = people.find((i) => i.id === Number(instructorId));
  if (!teacher) {
    const err = new Error('Pick a sensei.');
    err.status = 400;
    throw err;
  }
  await prepare('UPDATE schedule_draft_slots SET proposed_instructor_id=?, pinned=TRUE WHERE id=?').run(teacher.id, slot.id);
  await recompute(draft);
  const fresh = (await slotsFor(draft.id)).find((s) => s.id === slot.id);
  if (!fresh?.pinned) {
    const err = new Error('That sensei is outside their confirmed hours, away, or already teaching.');
    err.status = 400;
    throw err;
  }
}

export async function discardDraft(draft) {
  await prepare(`UPDATE schedule_drafts SET status='discarded', updated_at=${STAMP} WHERE id=?`).run(draft.id);
}

// Replace the slots on an existing draft. Does not insert a second draft and does not call Mindbody.
const DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const firstName = (name) => String(name || '').trim().split(/\s+/)[0];

function historyKey(start, end, name) {
  return `${dowOf(start.slice(0, 10))}|${start.slice(11, 16)}|${end.slice(11, 16)}|${normName(name)}`;
}

// Read-only look at why the saved December draft left slots with Kaizen Sensei.
export async function diagnoseDecember() {
  const draft = await prepare(
    "SELECT * FROM schedule_drafts WHERE target_start='2026-12-01' AND status='draft' ORDER BY id LIMIT 1",
  ).get();
  if (!draft) return { error: 'no december draft' };
  const ctx = await contextFor(draft);
  const slots = await slotsFor(draft.id);
  const explained = explainUnfilled({
    slots,
    instructors: ctx.instructors,
    timeoff: ctx.timeoff,
    fixedClasses: ctx.fixedClasses,
  });
  const primary = { no_availability: 0, overlap: 0, time_off: 0, power_surge: 0, other: 0 };
  const secondary = {};
  const clusters = new Map();
  for (const row of explained) {
    primary[row.primary] = (primary[row.primary] || 0) + 1;
    for (const code of row.secondary) secondary[code] = (secondary[code] || 0) + 1;
    const key = `${row.dow}|${row.time}|${row.type}`;
    if (!clusters.has(key)) clusters.set(key, { weekday: DAY[row.dow], time: row.time, type: row.type, count: 0, primary: {} });
    const cluster = clusters.get(key);
    cluster.count += 1;
    cluster.primary[row.primary] = (cluster.primary[row.primary] || 0) + 1;
  }
  const taught = new Map();
  for (const row of ctx.patternClasses) {
    if (row.cancelled) continue;
    const who = matchSensei(row.staffId, row.staffName, ctx.instructors);
    if (!who) continue;
    const key = historyKey(row.start, row.end, row.name);
    if (!taught.has(who.id)) taught.set(who.id, new Map());
    const bag = taught.get(who.id);
    bag.set(key, (bag.get(key) || 0) + 1);
  }
  const addHours = ctx.instructors.filter((i) => i.active).map((person) => {
    let uncovered = 0;
    let taughtSlots = 0;
    let score = 0;
    for (const row of explained) {
      const start = `${row.date}T${row.time}`;
      const end = `${row.date}T${row.end}`;
      if (hoursCover(person.hours, start, end)) continue;
      uncovered += 1;
      const n = taught.get(person.id)?.get(historyKey(start, end, row.name)) || 0;
      if (n) taughtSlots += 1;
      score += 1 + n;
    }
    return { name: firstName(person.name), uncovered, taughtSlots, score };
  }).filter((row) => row.uncovered).sort((a, b) => b.score - a.score || b.taughtSlots - a.taughtSlots || a.name.localeCompare(b.name));
  const activePeople = ctx.instructors.filter((i) => i.active);
  return {
    unfilled: explained.length,
    primary,
    secondary,
    sanity: {
      mondayIsZero: dowOf('2026-12-07') === 0,
      sundayIsSix: dowOf('2026-12-06') === 6,
      dateMismatch: explained.filter((row) => !row.dateMatchesStart).length,
      oneHour: explained.filter((row) => row.hours.length === 1).length,
      spansHours: explained.filter((row) => row.hours.length > 1).length,
    },
    senseis: {
      active: activePeople.length,
      noRows: activePeople.filter((i) => !i.hours.size).map((i) => firstName(i.name)),
      withRows: activePeople.filter((i) => i.hours.size).length,
      rowsButUnconfirmed: activePeople.filter((i) => i.hours.size && !i.confirmed).map((i) => firstName(i.name)),
    },
    clusters: [...clusters.values()].sort((a, b) => b.count - a.count || a.weekday.localeCompare(b.weekday) || a.time.localeCompare(b.time)).slice(0, 12),
    addHours: addHours.slice(0, 8),
  };
}

export async function rebuildDraft(draft) {
  const ctx = await contextFor(draft);
  const built = buildMonthDraft({
    patternClasses: ctx.patternClasses,
    targetClasses: ctx.targetClasses,
    instructors: ctx.instructors,
    timeoff: ctx.timeoff,
    fixedClasses: ctx.fixedClasses,
    location: draft.location,
    targetStart: draft.target_start,
    targetEnd: draft.target_end,
    patternStart: draft.pattern_start,
    patternEnd: draft.pattern_end,
  });
  await transaction(async () => {
    await prepare('DELETE FROM schedule_draft_slots WHERE draft_id=?').run(draft.id);
    await insertSlots(draft.id, built.slots);
    await prepare(`UPDATE schedule_drafts SET updated_at=${STAMP} WHERE id=?`).run(draft.id);
  });
  return built;
}

export function locationsFrom(classes) {
  const counts = new Map();
  for (const row of classes) {
    if (!row.location || row.cancelled) continue;
    counts.set(row.location, (counts.get(row.location) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
}

// Called from the sync route. Creates at most one draft per location per target month.
// Uses rows already stored. It does not call Mindbody.
export async function ensureFifteenthDrafts(today = todayLocal()) {
  if (process.env.VERCEL_ENV === 'preview') return { skipped: true, reason: 'preview' };
  const months = monthsForFifteenth(today);
  if (!months) return { skipped: true, reason: 'not_the_15th' };
  const patternClasses = await classesBetween(months.pattern.start, months.pattern.end);
  const locations = locationsFrom(patternClasses);
  const created = [];
  for (const location of locations) {
    const existing = await prepare(
      'SELECT id FROM schedule_drafts WHERE location=? AND target_start=? LIMIT 1',
    ).get(location, months.target.start);
    if (existing) continue;
    const draft = await createDraft({
      location,
      month: months.target.start.slice(0, 7),
      source: 'fifteenth',
    });
    if (draft) created.push(draft.id);
  }
  return { skipped: false, created };
}
