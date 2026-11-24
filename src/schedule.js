// Monthly draft. Builds next month from last month's weekday/time/class pattern,
// then fills teachers. It does not call Mindbody and it does not write.
import { addDays, dowOf, toMin } from './logic.js';

export const PLACEHOLDER_NAME = 'Kaizen Sensei';
const DAY = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function normName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function isPlaceholderName(name) {
  const n = normName(name).replace(/ /g, '');
  return n === 'kaizensensei' || n.includes('kaizensensei');
}

export function isPowerSurge(name) {
  return normName(name).startsWith('power surge');
}

export function eachDate(start, end) {
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

export function monthRange(year, month) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const end = addDays(`${nextYear}-${String(nextMonth).padStart(2, '0')}-01`, -1);
  return { start, end };
}

// On the 15th the target is the following calendar month and the pattern is this month.
export function monthsForFifteenth(today) {
  const [year, month, day] = String(today).split('-').map(Number);
  if (day !== 15) return null;
  const pattern = monthRange(year, month);
  const targetYear = month === 12 ? year + 1 : year;
  const targetMonth = month === 12 ? 1 : month + 1;
  return { pattern, target: monthRange(targetYear, targetMonth) };
}

export function previousMonth(monthKey) {
  const [year, month] = String(monthKey).split('-').map(Number);
  const y = month === 1 ? year - 1 : year;
  const m = month === 1 ? 12 : month - 1;
  return { key: `${y}-${String(m).padStart(2, '0')}`, ...monthRange(y, m) };
}

export function weekStart(date) {
  return addDays(date, -dowOf(date));
}

export function hoursCover(hours, start, end) {
  const s = toMin(start.slice(11));
  const e = toMin(end.slice(11));
  if (!(e > s)) return false;
  const dow = dowOf(start.slice(0, 10));
  for (let h = Math.floor(s / 60); h < Math.ceil(e / 60); h++) {
    if (!hours.has(`${dow}-${h}`)) return false;
  }
  return true;
}

export function isAway(timeoff, instructorId, start, end) {
  const date = start.slice(0, 10);
  const s = toMin(start.slice(11));
  const e = toMin(end.slice(11));
  return timeoff.some((t) => {
    if (t.instructorId !== instructorId) return false;
    if (t.startDate > date || t.endDate < date) return false;
    if (!t.startTime || !t.endTime) return true;
    return toMin(t.startTime) < e && toMin(t.endTime) > s;
  });
}

export function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

function personKey(name) {
  return normName(name).replace(/ /g, '');
}

export function matchSensei(staffId, staffName, instructors) {
  if (isPlaceholderName(staffName)) return null;
  if (staffId) {
    const hit = instructors.find((i) => i.mbStaffId && String(i.mbStaffId) === String(staffId));
    if (hit) return hit;
  }
  if (!staffName) return null;
  let n = staffName;
  if (n.includes(',')) {
    const [last, first] = n.split(',').map((s) => s.trim());
    n = `${first} ${last}`;
  }
  const key = personKey(n);
  const single = !n.trim().includes(' ');
  return instructors.find((i) => personKey(i.mbName || '') === key)
    || instructors.find((i) => personKey(i.name) === key)
    || (single ? instructors.find((i) => personKey((i.mbName || i.name).split(' ')[0]) === key) : null)
    || null;
}

function patternKey(dow, startTime, endTime, name) {
  return `${dow}|${startTime}|${endTime}|${normName(name)}`;
}

function sameLocation(a, b) {
  return normName(a) === normName(b);
}

// One entry per weekday + start + end + class name that occurred last month.
export function patternFromClasses(classes, location) {
  const grouped = new Map();
  for (const c of classes) {
    if (c.cancelled) continue;
    if (location && !sameLocation(c.location, location)) continue;
    const date = c.start.slice(0, 10);
    const startTime = c.start.slice(11, 16);
    const endTime = c.end.slice(11, 16);
    const key = patternKey(dowOf(date), startTime, endTime, c.name);
    if (!grouped.has(key)) {
      grouped.set(key, {
        dow: dowOf(date),
        startTime,
        endTime,
        names: new Map(),
      });
    }
    const row = grouped.get(key);
    row.names.set(c.name, (row.names.get(c.name) || 0) + 1);
  }
  return [...grouped.values()].map((row) => ({
    dow: row.dow,
    startTime: row.startTime,
    endTime: row.endTime,
    name: [...row.names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0],
  })).sort((a, b) => a.dow - b.dow || a.startTime.localeCompare(b.startTime) || a.name.localeCompare(b.name));
}

export function projectPattern(pattern, targetStart, targetEnd, location) {
  const slots = [];
  for (const date of eachDate(targetStart, targetEnd)) {
    const dow = dowOf(date);
    for (const slot of pattern) {
      if (slot.dow !== dow) continue;
      slots.push({
        date,
        start: `${date}T${slot.startTime}`,
        end: `${date}T${slot.endTime}`,
        name: slot.name,
        location,
      });
    }
  }
  return slots;
}

function usualCounts(patternClasses, instructors, location) {
  const counts = new Map();
  for (const c of patternClasses) {
    if (c.cancelled) continue;
    if (location && !sameLocation(c.location, location)) continue;
    const who = matchSensei(c.staffId, c.staffName, instructors);
    if (!who) continue;
    const key = patternKey(dowOf(c.start.slice(0, 10)), c.start.slice(11, 16), c.end.slice(11, 16), c.name);
    if (!counts.has(key)) counts.set(key, new Map());
    const bag = counts.get(key);
    bag.set(who.id, (bag.get(who.id) || 0) + 1);
  }
  const usual = new Map();
  for (const [key, bag] of counts) {
    const ranked = [...bag.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    usual.set(key, ranked[0][0]);
  }
  return usual;
}

function eligible(instructors, timeoff, commits, slot) {
  return instructors.filter((i) => i.active && i.confirmed
    && hoursCover(i.hours, slot.start, slot.end)
    && !isAway(timeoff, i.id, slot.start, slot.end)
    && !commits.some((c) => c.instructorId === i.id && overlaps(c.start, c.end, slot.start, slot.end)));
}

function loadOf(commits, instructorId, week) {
  return commits.filter((c) => c.instructorId === instructorId && c.week === week).length;
}

function pickTeacher(people, usualId, commits, slot, power) {
  if (!people.length) return { id: null, code: 'unfilled', load: 0 };
  const week = weekStart(slot.date);
  const loads = new Map(people.map((i) => [i.id, loadOf(commits, i.id, week)]));
  const lightest = Math.min(...loads.values());
  const usual = usualId != null ? people.find((i) => i.id === usualId) : null;
  if (power) {
    const heavy = people.filter((i) => loads.get(i.id) >= 7);
    if (heavy.length) {
      const lightestHeavy = Math.min(...heavy.map((i) => loads.get(i.id)));
      if (usual && loads.get(usual.id) >= 7 && loads.get(usual.id) <= lightestHeavy + 1) {
        return { id: usual.id, code: 'power_surge', load: loads.get(usual.id) };
      }
      const light = heavy.filter((i) => loads.get(i.id) === lightestHeavy).sort((a, b) => a.name.localeCompare(b.name));
      return { id: light[0].id, code: 'power_surge', load: lightestHeavy };
    }
  }
  if (usual && loads.get(usual.id) <= lightest + 1) {
    return { id: usual.id, code: 'usual', load: loads.get(usual.id) };
  }
  const light = people.filter((i) => loads.get(i.id) === lightest).sort((a, b) => a.name.localeCompare(b.name));
  return { id: light[0].id, code: power ? 'power_surge_spread' : 'lightest', load: lightest };
}

function reasonText(code, slot, teacher, load) {
  const when = `${DAY[dowOf(slot.date)]} ${slot.start.slice(11, 16)}`;
  if (code === 'unfilled') return 'Unfilled. Nobody is free inside confirmed hours, so this stays with Kaizen Sensei.';
  if (code === 'usual') return `Usual ${when} teacher, within 1 class of the lightest week (${load} classes).`;
  if (code === 'lightest') return `Lightest week so far (${load} classes).`;
  if (code === 'power_surge') return `Power Surge goes first to ${teacher?.name || 'this sensei'}, who already has ${load} classes this week.`;
  if (code === 'power_surge_spread') return `No sensei is at 7 classes this week yet. Lightest week so far (${load} classes).`;
  if (code === 'pinned') return 'Chosen by the manager.';
  return 'Assigned.';
}

function withKindNote(slot, text) {
  if (slot.kind === 'added' && !text.startsWith('Added class.')) return `Added class. ${text}`;
  if (slot.kind === 'missing') return `${text} Not in Mindbody for this date. A later step would create it.`;
  return text;
}

function commitOf(instructorId, start, end, slotId = null) {
  return { instructorId, start, end, week: weekStart(start.slice(0, 10)), slotId };
}

// slots: fill / missing / extra / added. fixedClasses are outside the draft month.
export function assignDraft(slots, { instructors, timeoff = [], fixedClasses = [], patternClasses = [], location }) {
  const usual = usualCounts(patternClasses, instructors, location);
  const commits = fixedClasses
    .map((c) => {
      const who = c.instructorId ? instructors.find((i) => i.id === c.instructorId) : matchSensei(c.staffId, c.staffName, instructors);
      if (!who) return null;
      return commitOf(who.id, c.start, c.end);
    })
    .filter(Boolean);

  const out = slots.map((s) => ({ ...s }));
  for (const slot of out) {
    if (slot.removed) {
      slot.proposedInstructorId = null;
      slot.reason = 'Removed. A later step would cancel this class in Mindbody.';
      continue;
    }
    if (slot.kind === 'extra') {
      slot.proposedInstructorId = null;
      slot.reason = 'Already in Mindbody and not in last month\'s pattern. Left as it is.';
      const who = matchSensei(slot.currentStaffId, slot.currentStaffName, instructors);
      if (who) commits.push(commitOf(who.id, slot.start, slot.end));
    }
  }

  const pinned = out.filter((s) => !s.removed && s.kind !== 'extra' && s.pinned && s.proposedInstructorId);
  for (const slot of pinned) {
    const people = eligible(instructors, timeoff, commits, slot);
    const teacher = people.find((i) => i.id === slot.proposedInstructorId);
    if (!teacher) {
      slot.pinned = false;
      slot.proposedInstructorId = null;
      continue;
    }
    commits.push(commitOf(teacher.id, slot.start, slot.end, slot.id));
    slot.reason = withKindNote(slot, reasonText('pinned', slot, teacher, 0));
  }

  const auto = out.filter((s) => !s.removed && s.kind !== 'extra' && !s.pinned);
  const ordered = [
    ...auto.filter((s) => !isPowerSurge(s.name)).sort((a, b) => a.start.localeCompare(b.start) || a.name.localeCompare(b.name)),
    ...auto.filter((s) => isPowerSurge(s.name)).sort((a, b) => a.start.localeCompare(b.start) || a.name.localeCompare(b.name)),
  ];
  for (const slot of ordered) {
    const people = eligible(instructors, timeoff, commits, slot);
    const key = patternKey(dowOf(slot.date), slot.start.slice(11, 16), slot.end.slice(11, 16), slot.name);
    const choice = pickTeacher(people, usual.get(key) ?? null, commits, slot, isPowerSurge(slot.name));
    const teacher = choice.id != null ? instructors.find((i) => i.id === choice.id) : null;
    slot.proposedInstructorId = choice.id;
    slot.reason = withKindNote(slot, reasonText(choice.code, slot, teacher, choice.load));
    if (teacher) commits.push(commitOf(teacher.id, slot.start, slot.end, slot.id));
    slot.eligibleIds = people.map((i) => i.id);
  }
  for (const slot of pinned) {
    const people = eligible(instructors, timeoff, commits.filter((c) => c.slotId !== slot.id), slot);
    slot.eligibleIds = people.map((i) => i.id);
  }
  return out;
}

function metaFrom(c) {
  return {
    classDescriptionId: c.classDescriptionId || null,
    locationId: c.locationId || null,
    resourceId: c.resourceId || null,
    staffPayRate: c.staffPayRate ?? null,
    maxCapacity: c.capacity ?? c.maxCapacity ?? null,
    webCapacity: c.webCapacity ?? null,
    waitlistCapacity: c.waitlistCapacity ?? null,
    bookingStatus: c.bookingStatus || null,
    classScheduleId: c.classScheduleId || null,
  };
}

export function buildMonthDraft({
  patternClasses, targetClasses, instructors, timeoff = [], fixedClasses = [], location, targetStart, targetEnd,
}) {
  const pattern = patternFromClasses(patternClasses, location);
  const projected = projectPattern(pattern, targetStart, targetEnd, location);
  const pool = targetClasses.filter((c) => !c.cancelled && (!location || sameLocation(c.location, location)));
  const used = new Set();
  const slots = [];
  for (const slot of projected) {
    const match = pool.find((c) => !used.has(c.id)
      && c.start.slice(0, 16) === slot.start
      && normName(c.name) === normName(slot.name));
    if (match) {
      used.add(match.id);
      slots.push({
        ...slot,
        ...metaFrom(match),
        kind: 'fill',
        classId: match.id,
        currentStaffId: match.staffId || null,
        currentStaffName: match.staffName || null,
        booked: match.booked ?? null,
        removed: false,
        pinned: false,
        proposedInstructorId: null,
      });
    } else {
      slots.push({
        ...slot,
        kind: 'missing',
        classId: null,
        currentStaffId: null,
        currentStaffName: PLACEHOLDER_NAME,
        booked: null,
        classDescriptionId: null,
        locationId: null,
        resourceId: null,
        staffPayRate: null,
        maxCapacity: null,
        webCapacity: null,
        waitlistCapacity: null,
        bookingStatus: null,
        classScheduleId: null,
        removed: false,
        pinned: false,
        proposedInstructorId: null,
      });
    }
  }
  for (const c of pool) {
    if (used.has(c.id)) continue;
    slots.push({
      date: c.start.slice(0, 10),
      start: c.start.slice(0, 16),
      end: c.end.slice(0, 16),
      name: c.name,
      location: c.location,
      ...metaFrom(c),
      kind: 'extra',
      classId: c.id,
      currentStaffId: c.staffId || null,
      currentStaffName: c.staffName || null,
      booked: c.booked ?? null,
      removed: false,
      pinned: false,
      proposedInstructorId: null,
    });
  }
  return assignDraft(slots, { instructors, timeoff, fixedClasses, patternClasses, location });
}

function sameTeacher(slot, instructor) {
  if (!instructor) return false;
  if (instructor.mbStaffId && slot.currentStaffId && String(instructor.mbStaffId) === String(slot.currentStaffId)) return true;
  return normName(instructor.name) === normName(slot.currentStaffName)
    || (instructor.mbName && normName(instructor.mbName) === normName(slot.currentStaffName));
}

export function summarizeDraft(slots, instructors) {
  const byId = new Map(instructors.map((i) => [i.id, i]));
  const brief = (s) => ({
    date: s.date || s.start.slice(0, 10),
    time: s.start.slice(11, 16),
    end: s.end.slice(11, 16),
    name: s.name,
    classId: s.classId || null,
    booked: s.booked || 0,
  });
  const active = slots.filter((s) => !s.removed);
  const creates = active.filter((s) => !s.classId).map(brief);
  const cancels = slots.filter((s) => s.removed && s.classId).map(brief);
  const substitutes = [];
  let unchanged = 0;
  for (const s of active) {
    if (s.kind === 'extra' || !s.classId) {
      if (s.kind === 'extra') unchanged += 1;
      continue;
    }
    const teacher = s.proposedInstructorId ? byId.get(s.proposedInstructorId) : null;
    if (teacher && !sameTeacher(s, teacher)) {
      substitutes.push({
        ...brief(s),
        from: s.currentStaffName || PLACEHOLDER_NAME,
        to: teacher.name,
      });
    } else if (teacher) unchanged += 1;
  }
  const unfilled = active
    .filter((s) => s.kind !== 'extra' && !s.proposedInstructorId)
    .map((s) => ({ ...brief(s), keeps: PLACEHOLDER_NAME }));
  return {
    creates,
    cancels,
    substitutes,
    unfilled,
    extras: active.filter((s) => s.kind === 'extra').length,
    unchanged,
    writes: false,
    phase: 1,
  };
}

// Phase 1 never writes. The flag and host are reported so a later phase can use the same gate.
export function publishDecision({ flag, host }) {
  const flagOn = flag === '1' || flag === true;
  const productionHost = host === 'sensei.kaizenpilates.ae';
  return {
    writes: false,
    phase: 1,
    flagOn,
    productionHost,
    message: 'Phase 1 lists changes only. Nothing is written to Mindbody.',
  };
}
