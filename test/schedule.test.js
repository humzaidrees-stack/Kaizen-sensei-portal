import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assignDraft, buildMonthDraft, eachDate, explainUnfilled, groupChanges, hoursCover, isAway, monthRange,
  monthsForFifteenth, patternFromClasses, projectPattern, publishDecision, summarizeDraft, templateView,
} from '../src/schedule.js';
import { dowOf } from '../src/logic.js';
import { historyRowFromMindbody } from '../src/mindbody.js';

const LOCATION = 'Kaizen Pilates';

function sensei(id, name, hours, extra = {}) {
  return {
    id,
    name,
    mbName: extra.mbName || name,
    mbStaffId: extra.mbStaffId || String(100 + id),
    active: extra.active !== false,
    confirmed: extra.confirmed !== false,
    hours: new Set(hours),
  };
}

function mondayHours() {
  return [6, 7, 8, 9, 10, 11, 12, 15, 16, 17, 18, 19, 20].map((h) => `0-${h}`);
}
function allWeekHours() {
  const hours = [];
  for (let dow = 0; dow < 7; dow++) {
    for (let h = 6; h <= 20; h++) hours.push(`${dow}-${h}`);
  }
  return hours;
}

describe('monthly draft rules', () => {
  it('projects last month onto the same weekdays and never emits a new time', () => {
    const november = monthRange(2026, 11);
    const december = monthRange(2026, 12);
    const mondays = eachDate(november.start, november.end).filter((d) => dowOf(d) === 0);
    const patternClasses = mondays.map((date, i) => ({
      id: `p${i}`,
      start: `${date}T08:00`,
      end: `${date}T09:00`,
      name: 'Core Power Mixed Gender',
      staffId: '101',
      staffName: 'Ana',
      location: LOCATION,
      cancelled: false,
    }));
    const pattern = patternFromClasses(patternClasses, LOCATION, november);
    assert.equal(pattern.dropped.length, 0);
    assert.deepEqual(pattern.slots.map((s) => [s.dow, s.startTime, s.endTime]), [[0, '08:00', '09:00']]);
    const projected = projectPattern(pattern.slots, december.start, december.end, LOCATION);
    const decemberMondays = eachDate(december.start, december.end).filter((d) => dowOf(d) === 0);
    assert.deepEqual(projected.map((s) => s.start), decemberMondays.map((d) => `${d}T08:00`));
    assert.equal(projected.some((s) => s.start.slice(11) !== '08:00'), false);
    assert.equal(projected.some((s) => dowOf(s.date) !== 0), false);

    const firstMonday = decemberMondays[0];
    const targetClasses = [
      {
        id: 'live1', start: `${firstMonday}T08:00`, end: `${firstMonday}T09:00`,
        name: 'Core Power Mixed Gender', staffName: 'Kaizen Sensei', location: LOCATION, cancelled: false,
      },
      {
        id: 'extra1', start: `${december.start}T11:00`, end: `${december.start}T12:00`,
        name: 'Workshop', staffName: 'Bea', location: LOCATION, cancelled: false,
      },
    ];
    const ana = sensei(1, 'Ana', allWeekHours());
    const bea = sensei(2, 'Bea', allWeekHours());
    const slots = buildMonthDraft({
      patternClasses, targetClasses, instructors: [ana, bea], location: LOCATION,
      targetStart: december.start, targetEnd: december.end,
      patternStart: november.start, patternEnd: november.end,
    }).slots;
    const generated = slots.filter((s) => s.kind !== 'extra');
    assert.equal(generated.every((s) => s.start.endsWith('T08:00') && dowOf(s.date) === 0), true);
    assert.equal(generated.some((s) => s.kind === 'added'), false);
    assert.equal(generated.filter((s) => s.kind === 'fill').length, 1);
    assert.equal(generated.filter((s) => s.kind === 'missing').length, decemberMondays.length - 1);
    assert.equal(slots.filter((s) => s.kind === 'extra').length, 1);
    assert.match(slots.find((s) => s.kind === 'missing').reason, /create it/);
  });

  it('uses only confirmed hours, skips time off and overlaps, and leaves Kaizen Sensei', () => {
    const slot = {
      date: '2026-12-07', start: '2026-12-07T08:00', end: '2026-12-07T09:00',
      name: 'Core Power', location: LOCATION, kind: 'fill', classId: 'c1',
      currentStaffName: 'Kaizen Sensei', removed: false, pinned: false,
    };
    const ana = sensei(1, 'Ana', mondayHours(), { confirmed: false });
    const bea = sensei(2, 'Bea', mondayHours());
    const cara = sensei(3, 'Cara', ['0-18']);
    const off = assignDraft([{ ...slot }], {
      instructors: [ana, bea],
      timeoff: [{ instructorId: 2, startDate: '2026-12-07', endDate: '2026-12-07', startTime: null, endTime: null }],
    });
    assert.equal(off[0].proposedInstructorId, null);
    assert.match(off[0].reason, /Kaizen Sensei/);

    const hours = assignDraft([{ ...slot }], { instructors: [cara, bea] });
    assert.equal(hours[0].proposedInstructorId, 2);

    const busy = assignDraft([{ ...slot }], {
      instructors: [bea, sensei(4, 'Dana', mondayHours())],
      fixedClasses: [{ instructorId: 2, start: '2026-12-07T08:00', end: '2026-12-07T09:00' }],
    });
    assert.equal(busy[0].proposedInstructorId, 4);
    assert.equal(isAway([{ instructorId: 1, startDate: '2026-12-07', endDate: '2026-12-07' }], 1, slot.start, slot.end), true);
    assert.equal(hoursCover(new Set(['0-8']), slot.start, slot.end), true);
    assert.equal(hoursCover(new Set(['0-18']), slot.start, slot.end), false);
  });

  it('spreads classes and keeps the usual teacher within one class of the lightest week', () => {
    const make = (hour, name) => ({
      date: '2026-12-07',
      start: `2026-12-07T${String(hour).padStart(2, '0')}:00`,
      end: `2026-12-07T${String(hour + 1).padStart(2, '0')}:00`,
      name, location: LOCATION, kind: 'fill', classId: `c${hour}`,
      currentStaffName: 'Kaizen Sensei', removed: false, pinned: false,
    });
    const ana = sensei(1, 'Ana', mondayHours());
    const bea = sensei(2, 'Bea', mondayHours());
    const spread = assignDraft([make(8, 'Core Power'), make(9, 'Gentle Flow'), make(10, 'Active Sculpt')], {
      instructors: [ana, bea],
    });
    const counts = { 1: 0, 2: 0 };
    for (const slot of spread) counts[slot.proposedInstructorId] += 1;
    assert.deepEqual(counts, { 1: 2, 2: 1 });

    const usualClasses = ['2026-11-02', '2026-11-09', '2026-11-16'].map((date) => ({
      id: date, start: `${date}T08:00`, end: `${date}T09:00`, name: 'Core Power',
      staffId: '101', staffName: 'Ana', location: LOCATION, cancelled: false,
    }));
    const kept = assignDraft([make(8, 'Core Power')], {
      instructors: [ana, bea],
      patternClasses: usualClasses,
      fixedClasses: [
        { instructorId: 1, start: '2026-12-08T08:00', end: '2026-12-08T09:00' },
      ],
      location: LOCATION,
    });
    assert.equal(kept[0].proposedInstructorId, 1);
    assert.match(kept[0].reason, /Usual/);

    const heavyUsual = assignDraft([make(8, 'Core Power')], {
      instructors: [ana, bea],
      patternClasses: usualClasses,
      fixedClasses: [8, 9, 10].map((hour) => ({
        instructorId: 1, start: `2026-12-08T${hour}:00`, end: `2026-12-08T${hour + 1}:00`,
      })),
      location: LOCATION,
    });
    assert.equal(heavyUsual[0].proposedInstructorId, 2);
    assert.match(heavyUsual[0].reason, /Lightest/);
  });

  it('gives Power Surge first to a sensei already at 7 classes that week', () => {
    const ana = sensei(1, 'Ana', allWeekHours());
    const bea = sensei(2, 'Bea', allWeekHours());
    const fixed = [8, 9, 10, 11, 12, 15, 16].map((hour) => ({
      instructorId: 1, start: `2026-12-08T${String(hour).padStart(2, '0')}:00`, end: `2026-12-08T${String(hour + 1).padStart(2, '0')}:00`,
    }));
    const surge = {
      date: '2026-12-09', start: '2026-12-09T18:00', end: '2026-12-09T19:00',
      name: 'Power Surge Mixed Gender - High Intensity', location: LOCATION, kind: 'missing',
      currentStaffName: 'Kaizen Sensei', removed: false, pinned: false,
    };
    const other = {
      date: '2026-12-09', start: '2026-12-09T10:00', end: '2026-12-09T11:00',
      name: 'Gentle Flow', location: LOCATION, kind: 'fill', classId: 'g',
      currentStaffName: 'Kaizen Sensei', removed: false, pinned: false,
    };
    const slots = assignDraft([surge, other], { instructors: [ana, bea], fixedClasses: fixed });
    const power = slots.find((s) => s.name.startsWith('Power Surge'));
    const flow = slots.find((s) => s.name === 'Gentle Flow');
    assert.equal(power.proposedInstructorId, 1);
    assert.match(power.reason, /Power Surge/);
    assert.equal(flow.proposedInstructorId, 2);

    const nobodyHeavy = assignDraft([surge], {
      instructors: [ana, bea],
      fixedClasses: fixed.slice(0, 6),
    });
    assert.equal(nobodyHeavy[0].proposedInstructorId, 2);
    assert.match(nobodyHeavy[0].reason, /Power Surge fallback/);
  });

  it('drops a weekday slot that did not recur in most weeks, and does not invent a time', () => {
    const november = monthRange(2026, 11);
    const december = monthRange(2026, 12);
    const mondays = eachDate(november.start, november.end).filter((d) => dowOf(d) === 0);
    assert.equal(mondays.length, 5);
    const regular = mondays.slice(0, 3).map((date, i) => ({
      id: `r${i}`, start: `${date}T08:00`, end: `${date}T09:00`,
      name: 'Core Power', staffName: 'Ana', location: LOCATION, cancelled: false,
    }));
    const once = {
      id: 'once', start: `${mondays[4]}T20:00`, end: `${mondays[4]}T21:00`,
      name: 'Workshop', staffName: 'Bea', location: LOCATION, cancelled: false,
    };
    const pattern = patternFromClasses([...regular, once], LOCATION, november);
    assert.equal(pattern.dropped.length, 1);
    assert.equal(pattern.dropped[0].startTime, '20:00');
    assert.deepEqual(pattern.slots.map((s) => s.startTime), ['08:00']);
    const built = buildMonthDraft({
      patternClasses: [...regular, once],
      targetClasses: [],
      instructors: [sensei(1, 'Ana', allWeekHours())],
      location: LOCATION,
      targetStart: december.start,
      targetEnd: december.end,
      patternStart: november.start,
      patternEnd: november.end,
    });
    assert.equal(built.dropped, 1);
    assert.equal(built.slots.some((s) => s.start.endsWith('T20:00')), false);
    assert.equal(built.slots.every((s) => s.start.endsWith('T08:00')), true);
  });

  it('falls back to the normal rule for Power Surge when nobody is already at 7, and stays with Kaizen Sensei only if nobody is free', () => {
    const ana = sensei(1, 'Ana', allWeekHours());
    const bea = sensei(2, 'Bea', allWeekHours());
    const surge = {
      date: '2026-12-09', start: '2026-12-09T18:00', end: '2026-12-09T19:00',
      name: 'Power Surge Mixed Gender', location: LOCATION, kind: 'fill', classId: 'ps',
      currentStaffName: 'Kaizen Sensei', removed: false, pinned: false,
    };
    const usualClasses = ['2026-11-04', '2026-11-11', '2026-11-18'].map((date) => ({
      id: date, start: `${date}T18:00`, end: `${date}T19:00`, name: 'Power Surge Mixed Gender',
      staffId: '101', staffName: 'Ana', location: LOCATION, cancelled: false,
    }));
    const usualFallback = assignDraft([surge], {
      instructors: [ana, bea],
      patternClasses: usualClasses,
      fixedClasses: [{ instructorId: 1, start: '2026-12-08T08:00', end: '2026-12-08T09:00' }],
      location: LOCATION,
    });
    assert.equal(usualFallback[0].proposedInstructorId, 1);
    assert.match(usualFallback[0].reason, /Power Surge fallback/);
    assert.match(usualFallback[0].reason, /Usual/);

    const lightFallback = assignDraft([surge], {
      instructors: [ana, bea],
      patternClasses: usualClasses,
      fixedClasses: [8, 9, 10].map((hour) => ({
        instructorId: 1, start: `2026-12-08T${String(hour).padStart(2, '0')}:00`, end: `2026-12-08T${String(hour + 1).padStart(2, '0')}:00`,
      })),
      location: LOCATION,
    });
    assert.equal(lightFallback[0].proposedInstructorId, 2);
    assert.match(lightFallback[0].reason, /Power Surge fallback/);
    assert.match(lightFallback[0].reason, /Lightest/);

    const none = assignDraft([surge], {
      instructors: [sensei(1, 'Ana', allWeekHours(), { confirmed: false })],
    });
    assert.equal(none[0].proposedInstructorId, null);
    assert.match(none[0].reason, /Kaizen Sensei/);
  });

  it('classifies an unfilled slot by the first real blocker', () => {
    const slot = {
      date: '2026-12-07', start: '2026-12-07T08:00', end: '2026-12-07T09:00',
      name: 'Core Power', location: LOCATION, kind: 'fill',
      currentStaffName: 'Kaizen Sensei', removed: false, pinned: false, proposedInstructorId: null,
    };
    const open = explainUnfilled({
      slots: [slot],
      instructors: [sensei(1, 'Ana', ['0-9'])],
    });
    assert.equal(open[0].primary, 'no_availability');
    assert.equal(open[0].dow, 0);
    assert.deepEqual(open[0].hours, [8]);

    const partial = explainUnfilled({
      slots: [{ ...slot, start: '2026-12-07T06:30', end: '2026-12-07T07:30' }],
      instructors: [sensei(1, 'Ana', ['0-6'])],
    });
    assert.equal(partial[0].primary, 'no_availability');
    assert.ok(partial[0].secondary.includes('partial_hour'));
    assert.deepEqual(partial[0].hours, [6, 7]);

    const away = explainUnfilled({
      slots: [slot],
      instructors: [sensei(1, 'Ana', mondayHours())],
      timeoff: [{ instructorId: 1, startDate: '2026-12-07', endDate: '2026-12-07' }],
    });
    assert.equal(away[0].primary, 'time_off');

    const busy = explainUnfilled({
      slots: [
        { ...slot, proposedInstructorId: 1, start: '2026-12-07T07:00', end: '2026-12-07T08:30', name: 'Gentle Flow' },
        slot,
      ],
      instructors: [sensei(1, 'Ana', mondayHours())],
    });
    const unfilled = busy.find((row) => row.time === '08:00');
    assert.equal(unfilled.primary, 'overlap');
  });

  it('shows one weekly row and lists only the dates that differ', () => {
    const base = (date, id, who) => ({
      id, date, start: `${date}T08:00`, end: `${date}T09:00`, name: 'Core Power Mixed Gender - Medium',
      kind: 'fill', removed: false, proposedInstructorId: who, proposedName: who === 1 ? 'Ana Teacher' : 'Kaizen Sensei',
      options: [{ id: 1, name: 'Ana Teacher' }, { id: 2, name: 'Bea Teacher' }],
    });
    const view = templateView([
      base('2026-12-07', 1, 1),
      base('2026-12-14', 2, 1),
      base('2026-12-21', 3, 1),
      base('2026-12-28', 4, null),
      { id: 9, date: '2026-12-03', start: '2026-12-03T11:00', end: '2026-12-03T12:00', name: 'Workshop', kind: 'extra', removed: false, proposedName: 'Bea Teacher', options: [] },
    ]);
    assert.equal(view.rows.length, 1);
    assert.equal(view.rows[0].weekday, 'Mon');
    assert.equal(view.rows[0].time, '08:00');
    assert.equal(view.rows[0].senseiId, 1);
    assert.equal(view.rows[0].filled, 3);
    assert.equal(view.rows[0].total, 4);
    assert.equal(view.unfilled, 1);
    assert.equal(view.exceptions.length, 2);
    assert.equal(view.exceptions.some((row) => row.label === 'Unfilled' && row.date === '2026-12-28'), true);
    assert.equal(view.exceptions.some((row) => row.label === 'Extra'), true);
    assert.equal(view.rows[0].suggested[0].weeks >= view.rows[0].suggested[1].weeks, true);
    const grouped = groupChanges({
      substitutes: [
        { date: '2026-12-07', time: '08:00', name: 'Core Power', to: 'Ana' },
        { date: '2026-12-14', time: '08:00', name: 'Core Power', to: 'Ana' },
        { date: '2026-12-08', time: '09:00', name: 'Gentle Flow', to: 'Bea' },
      ],
      creates: [], cancels: [], unfilled: [{ date: '2026-12-28', time: '08:00', name: 'Core Power' }],
    });
    assert.equal(grouped.substitutes.templates.length, 1);
    assert.equal(grouped.substitutes.templates[0].weeks, 2);
    assert.equal(grouped.substitutes.oneOffs.length, 1);
    assert.equal(grouped.unfilled.oneOffs.length, 1);
  });

  it('lists creates and cancels and never turns publish into a Mindbody write', () => {
    const ana = sensei(1, 'Ana', mondayHours(), { mbStaffId: '55' });
    const slots = [
      {
        date: '2026-12-07', start: '2026-12-07T08:00', end: '2026-12-07T09:00', name: 'Core Power',
        location: LOCATION, kind: 'fill', classId: '9', currentStaffId: '1', currentStaffName: 'Kaizen Sensei',
        proposedInstructorId: 1, removed: false, booked: 0,
      },
      {
        date: '2026-12-07', start: '2026-12-07T09:00', end: '2026-12-07T10:00', name: 'Gentle Flow',
        location: LOCATION, kind: 'missing', classId: null, proposedInstructorId: 1, removed: false,
      },
      {
        date: '2026-12-08', start: '2026-12-08T10:00', end: '2026-12-08T11:00', name: 'Core Power',
        location: LOCATION, kind: 'fill', classId: '12', currentStaffName: 'Ana', removed: true, booked: 3,
      },
    ];
    const diff = summarizeDraft(slots, [ana]);
    assert.equal(diff.writes, false);
    assert.equal(diff.phase, 1);
    assert.equal(diff.substitutes.length, 1);
    assert.equal(diff.substitutes[0].to, 'Ana');
    assert.equal(diff.creates.length, 1);
    assert.equal(diff.cancels.length, 1);
    assert.equal(diff.cancels[0].booked, 3);
    const locked = publishDecision({ flag: '1', host: 'sensei.kaizenpilates.ae' });
    assert.equal(locked.writes, false);
    assert.equal(locked.flagOn, true);
    assert.equal(locked.productionHost, true);
    const preview = publishDecision({ flag: '1', host: 'kaizen-sensei-portal-git-preview.vercel.app' });
    assert.equal(preview.productionHost, false);
    assert.equal(preview.writes, false);
  });

  it('knows the 15th builds the following month from the current month', () => {
    const hit = monthsForFifteenth('2026-12-15');
    assert.equal(hit.pattern.start, '2026-12-01');
    assert.equal(hit.pattern.end, '2026-12-31');
    assert.equal(hit.target.start, '2027-01-01');
    assert.equal(hit.target.end, '2027-01-31');
    assert.equal(monthsForFifteenth('2026-12-16'), null);
    assert.equal(monthsForFifteenth('2026-11-15').target.start, '2026-12-01');
  });

  it('keeps schedule fields from a Mindbody class and drops client payloads', () => {
    const row = historyRowFromMindbody({
      Id: 17446,
      StartDateTime: '2026-12-03T08:00:00',
      EndDateTime: '2026-12-03T09:00:00',
      ClassDescription: { Id: 12, Name: 'Core Power Mixed Gender' },
      Staff: { Id: 9, DisplayName: 'Ana' },
      Location: { Id: 1, Name: 'Kaizen Pilates' },
      ClassScheduleId: 80,
      Resource: { Id: 3, Name: 'Studio' },
      MaxCapacity: 12,
      WebCapacity: 10,
      WaitlistCapacity: 4,
      TotalBooked: 6,
      IsCanceled: false,
      Clients: [{ Id: 1, Email: 'hidden@example.com' }],
      Visits: [{ ClientId: 1 }],
    });
    assert.equal(row.id, '17446');
    assert.equal(row.classDescriptionId, '12');
    assert.equal(row.resourceId, '3');
    assert.equal(row.booked, 6);
    assert.equal(JSON.stringify(row).includes('hidden@example.com'), false);
    assert.equal(JSON.stringify(row).includes('Client'), false);
  });
});
