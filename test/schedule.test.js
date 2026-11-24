import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assignDraft, buildMonthDraft, eachDate, hoursCover, isAway, monthRange, monthsForFifteenth,
  patternFromClasses, projectPattern, publishDecision,   summarizeDraft,
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
    const pattern = patternFromClasses(patternClasses, LOCATION);
    assert.deepEqual(pattern.map((s) => [s.dow, s.startTime, s.endTime]), [[0, '08:00', '09:00']]);
    const projected = projectPattern(pattern, december.start, december.end, LOCATION);
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
    });
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
    assert.match(nobodyHeavy[0].reason, /No sensei is at 7/);
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
