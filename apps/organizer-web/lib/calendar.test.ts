import { describe, expect, it } from 'vitest';
import type { OrganizerCalendarSession } from '@eticketsgo/web-kit';
import {
  addMonths,
  canCreateEvents,
  capItems,
  defaultViewFor,
  displayStatus,
  statusText,
  statusTone,
  fetchWindow,
  filterOptions,
  filterSessions,
  focusTarget,
  layoutDay,
  localPlace,
  monthGrid,
  rangeTitle,
  segmentsByDay,
  sessionZone,
  splitSpanning,
  startOfWeek,
  stepAnchor,
  toCalendarSessions,
  visibleRange,
  weekDays,
  weekStartFor,
  zoneAbbrev,
  type CalendarSession,
  type DaySegment,
} from './calendar';

function session(over: Partial<CalendarSession>): CalendarSession {
  return {
    id: 's1',
    eventId: 'e1',
    title: 'Show',
    category: 'Music',
    eventStatus: 'PUBLISHED',
    sessionStatus: 'SCHEDULED',
    venueId: 'v1',
    venueName: 'Hall',
    city: 'Hyderabad',
    zone: 'Asia/Kolkata',
    zoneKnown: true,
    startsAt: '2026-11-06T13:30:00.000Z',
    endsAt: '2026-11-06T16:30:00.000Z',
    sold: null,
    capacity: null,
    ...over,
  };
}

describe('range math', () => {
  it('starts a week on Monday or Sunday, from any day in it', () => {
    // 2026-10-09 is a Friday.
    expect(startOfWeek('2026-10-09', 1)).toBe('2026-10-05');
    expect(startOfWeek('2026-10-09', 0)).toBe('2026-10-04');
    expect(startOfWeek('2026-10-05', 1)).toBe('2026-10-05');
    expect(startOfWeek('2026-10-04', 1)).toBe('2026-09-28');
    expect(weekDays('2026-10-09', 0)).toEqual([
      '2026-10-04',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
      '2026-10-10',
    ]);
  });

  it('weeks start on Sunday in the US and Canada, Monday elsewhere', () => {
    expect(weekStartFor('US')).toBe(0);
    expect(weekStartFor('Canada')).toBe(0);
    expect(weekStartFor('IN')).toBe(1);
    expect(weekStartFor(null)).toBe(1);
  });

  it('draws a month as whole weeks covering the 1st to the last day', () => {
    // February 2026 begins on a Sunday: with Sunday weeks it is exactly four rows.
    const sun = monthGrid('2026-02-14', 0);
    expect(sun).toHaveLength(4);
    expect(sun[0][0]).toBe('2026-02-01');
    expect(sun[3][6]).toBe('2026-02-28');
    // With Monday weeks the 1st sits at the END of the first row, so it needs five.
    const mon = monthGrid('2026-02-14', 1);
    expect(mon).toHaveLength(5);
    expect(mon[0][0]).toBe('2026-01-26');
    expect(mon[0][6]).toBe('2026-02-01');
    expect(mon[4][6]).toBe('2026-03-01');
  });

  it('gives each view its own visible range', () => {
    expect(visibleRange('day', '2026-10-09', 1)).toEqual({ from: '2026-10-09', to: '2026-10-09' });
    expect(visibleRange('week', '2026-10-09', 1)).toEqual({
      from: '2026-10-05',
      to: '2026-10-11',
    });
    expect(visibleRange('month', '2026-10-09', 1)).toEqual({
      from: '2026-09-28',
      to: '2026-11-01',
    });
    expect(visibleRange('agenda', '2026-10-09', 1)).toEqual({
      from: '2026-10-01',
      to: '2026-10-31',
    });
  });

  it('pages by the view, clamping a month step to the shorter month', () => {
    expect(stepAnchor('month', '2026-01-31', 1)).toBe('2026-02-28');
    expect(stepAnchor('agenda', '2024-03-31', -1)).toBe('2024-02-29');
    expect(stepAnchor('week', '2026-12-29', 1)).toBe('2027-01-05');
    expect(stepAnchor('day', '2026-03-01', -1)).toBe('2026-02-28');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
  });

  it('titles the toolbar for the view', () => {
    expect(rangeTitle('month', '2026-11-06', 1)).toBe('November 2026');
    expect(rangeTitle('week', '2026-11-06', 1)).toBe('2 Nov - 8 Nov 2026');
    expect(rangeTitle('day', '2026-11-06', 1)).toBe('Fri, 6 Nov 2026');
  });
});

describe('keyboard focus in the month grid', () => {
  it('moves a day with left/right, a week with up/down, and to the week ends', () => {
    expect(focusTarget('2026-10-01', 'ArrowLeft', 1)).toBe('2026-09-30');
    expect(focusTarget('2026-10-31', 'ArrowRight', 1)).toBe('2026-11-01');
    expect(focusTarget('2026-10-09', 'ArrowUp', 1)).toBe('2026-10-02');
    expect(focusTarget('2026-10-09', 'ArrowDown', 1)).toBe('2026-10-16');
    expect(focusTarget('2026-10-09', 'Home', 1)).toBe('2026-10-05');
    expect(focusTarget('2026-10-09', 'End', 0)).toBe('2026-10-10');
    expect(focusTarget('2026-10-09', 'a', 1)).toBeNull();
  });
});

describe('placing a session at its venue-local time', () => {
  it('puts a Hyderabad 19:00 and a Boise 19:00 both at 19:00 on their own day', () => {
    const hyderabad = session({ id: 'hyd', startsAt: '2026-11-06T13:30:00.000Z' });
    const boise = session({
      id: 'boi',
      zone: 'America/Boise',
      city: 'Boise',
      // 19:00 MST (UTC-7) on 6 Nov is 02:00Z on the 7th.
      startsAt: '2026-11-07T02:00:00.000Z',
      endsAt: '2026-11-07T04:00:00.000Z',
    });
    const days = segmentsByDay([hyderabad, boise], '2026-11-01', '2026-11-30');
    const sixth = days.get('2026-11-06')!;
    expect(sixth.map((s) => [s.session.id, s.startMin])).toEqual([
      // Same start: the longer (Hyderabad, three hours) is listed first.
      ['hyd', 19 * 60],
      ['boi', 19 * 60],
    ]);
    // Neither is drawn on the day the BROWSER or UTC would have put it on.
    expect(days.get('2026-11-07')).toEqual([]);
    expect(zoneAbbrev('America/Boise', boise.startsAt)).toBe('MST');
  });

  it('keeps a zone without DST at the same offset all year', () => {
    // India has no DST: 13:30Z is 19:00 in March and in November alike.
    expect(localPlace('2026-03-08T13:30:00.000Z', 'Asia/Kolkata')).toEqual({
      day: '2026-03-08',
      minute: 19 * 60,
    });
    expect(localPlace('2026-11-01T13:30:00.000Z', 'Asia/Kolkata')).toEqual({
      day: '2026-11-01',
      minute: 19 * 60,
    });
  });

  it('follows New York across both DST changes', () => {
    // 19:00 EST (UTC-5) the day before the spring change, 19:00 EDT (UTC-4) on the day itself.
    expect(localPlace('2026-03-08T00:00:00.000Z', 'America/New_York')).toEqual({
      day: '2026-03-07',
      minute: 19 * 60,
    });
    expect(localPlace('2026-03-08T23:00:00.000Z', 'America/New_York')).toEqual({
      day: '2026-03-08',
      minute: 19 * 60,
    });
    // On 1 Nov 2026 the clock goes back: 19:00 that evening is EST again.
    expect(localPlace('2026-11-02T00:00:00.000Z', 'America/New_York')).toEqual({
      day: '2026-11-01',
      minute: 19 * 60,
    });
    expect(zoneAbbrev('America/New_York', '2026-10-31T23:00:00.000Z')).toBe('EDT');
    expect(zoneAbbrev('America/New_York', '2026-11-02T00:00:00.000Z')).toBe('EST');
  });

  it('draws a show spanning the spring-forward gap by its wall-clock ends', () => {
    // 01:00 EST to 04:00 EDT on 8 Mar 2026: two real hours, drawn 01:00 to 04:00 on the day.
    const s = session({
      zone: 'America/New_York',
      startsAt: '2026-03-08T06:00:00.000Z',
      endsAt: '2026-03-08T08:00:00.000Z',
    });
    const [seg] = segmentsByDay([s], '2026-03-08', '2026-03-08').get('2026-03-08')!;
    expect([seg.startMin, seg.endMin]).toEqual([60, 240]);
  });
});

describe('multi-day sessions', () => {
  it('spans every day it touches, marking where it continues', () => {
    // A festival from 18:00 on the 6th to 02:00 on the 9th, in Hyderabad.
    const fest = session({
      startsAt: '2026-11-06T12:30:00.000Z',
      endsAt: '2026-11-08T20:30:00.000Z',
    });
    const days = segmentsByDay([fest], '2026-11-05', '2026-11-10');
    const touched = [...days].filter(([, l]) => l.length > 0).map(([d]) => d);
    expect(touched).toEqual(['2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09']);
    const [first] = days.get('2026-11-06')!;
    const [middle] = days.get('2026-11-07')!;
    const [last] = days.get('2026-11-09')!;
    expect([first.startMin, first.endMin, first.continuesBefore, first.continuesAfter]).toEqual([
      18 * 60,
      1440,
      false,
      true,
    ]);
    expect([middle.startMin, middle.endMin]).toEqual([0, 1440]);
    expect([last.startMin, last.endMin, last.continuesBefore, last.continuesAfter]).toEqual([
      0,
      120,
      true,
      false,
    ]);
  });

  it('does not spill a show that ends exactly at midnight into the next day', () => {
    const late = session({
      startsAt: '2026-11-06T14:30:00.000Z', // 20:00 IST
      endsAt: '2026-11-06T18:30:00.000Z', // 00:00 IST on the 7th
    });
    const days = segmentsByDay([late], '2026-11-06', '2026-11-07');
    expect(days.get('2026-11-06')!.map((s) => s.endMin)).toEqual([1440]);
    expect(days.get('2026-11-07')).toEqual([]);
  });

  it('clips a long session to the visible range without losing it', () => {
    const long = session({
      startsAt: '2026-10-01T00:00:00.000Z',
      endsAt: '2026-12-01T00:00:00.000Z',
    });
    const days = segmentsByDay([long], '2026-11-02', '2026-11-03');
    expect(days.get('2026-11-02')).toHaveLength(1);
    expect(days.get('2026-11-03')![0].continuesAfter).toBe(true);
  });

  it('keeps a session whose end is not after its start, as a point', () => {
    const bad = session({ endsAt: '2026-11-06T13:30:00.000Z' });
    const [seg] = segmentsByDay([bad], '2026-11-06', '2026-11-06').get('2026-11-06')!;
    expect([seg.startMin, seg.endMin]).toEqual([19 * 60, 19 * 60]);
  });
});

describe('multi-day sessions in the week and day grid', () => {
  it('moves a session that crosses midnight into the strip, keeping the rest timed', () => {
    const fest = session({
      id: 'fest',
      startsAt: '2026-11-06T12:30:00.000Z',
      endsAt: '2026-11-08T20:30:00.000Z',
    });
    const evening = session({ id: 'evening' });
    const days = segmentsByDay([fest, evening], '2026-11-06', '2026-11-06');
    const { timed, spanning } = splitSpanning(days.get('2026-11-06')!);
    expect(timed.map((s) => s.session.id)).toEqual(['evening']);
    expect(spanning.map((s) => s.session.id)).toEqual(['fest']);
  });
});

describe('overlap layout', () => {
  function seg(id: string, startMin: number, endMin: number): DaySegment {
    return {
      session: session({ id }),
      day: '2026-11-06',
      startMin,
      endMin,
      continuesBefore: false,
      continuesAfter: false,
    };
  }
  const layout = (list: DaySegment[]) =>
    Object.fromEntries(layoutDay(list).map((p) => [p.segment.session.id, [p.column, p.columns]]));

  it('lays overlapping sessions side by side and leaves separate ones full width', () => {
    expect(
      layout([seg('a', 600, 720), seg('b', 660, 780), seg('c', 690, 750), seg('d', 900, 960)]),
    ).toEqual({ a: [0, 3], b: [1, 3], c: [2, 3], d: [0, 1] });
  });

  it('reuses a freed column inside a chain, and sizes the whole chain alike', () => {
    // a overlaps b, b overlaps c, a and c do not: two columns are enough for all three.
    expect(layout([seg('a', 600, 660), seg('b', 630, 720), seg('c', 660, 750)])).toEqual({
      a: [0, 2],
      b: [1, 2],
      c: [0, 2],
    });
  });

  it('treats back-to-back sessions as not overlapping', () => {
    expect(layout([seg('a', 600, 660), seg('b', 660, 720)])).toEqual({ a: [0, 1], b: [0, 1] });
  });

  it('gives a very short session its drawn height, so two are not stacked', () => {
    expect(layout([seg('a', 600, 605), seg('b', 610, 615)])).toEqual({ a: [0, 2], b: [1, 2] });
  });

  it('never drops a segment', () => {
    const many = Array.from({ length: 12 }, (_, i) => seg(`s${i}`, 600, 700));
    const placed = layoutDay(many);
    expect(placed).toHaveLength(12);
    expect(new Set(placed.map((p) => p.column)).size).toBe(12);
  });
});

describe('filters', () => {
  const list = [
    session({ id: 'a', eventStatus: 'DRAFT', venueId: 'v1', category: 'Music' }),
    session({ id: 'b', eventStatus: 'PUBLISHED', venueId: 'v2', category: 'Comedy' }),
    session({ id: 'c', eventStatus: 'PUBLISHED', venueId: 'v1', category: 'Comedy' }),
  ];
  const ids = (l: CalendarSession[]) => l.map((s) => s.id);

  it('filters by event status, venue and category together', () => {
    expect(ids(filterSessions(list, { status: '', venueId: '', category: '' }))).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(ids(filterSessions(list, { status: 'PUBLISHED', venueId: '', category: '' }))).toEqual([
      'b',
      'c',
    ]);
    expect(
      ids(filterSessions(list, { status: 'PUBLISHED', venueId: 'v1', category: 'Comedy' })),
    ).toEqual(['c']);
    expect(ids(filterSessions(list, { status: 'CANCELLED', venueId: '', category: '' }))).toEqual(
      [],
    );
  });

  it('offers every venue and every category the organization uses, sorted', () => {
    const opts = filterOptions(
      [
        { id: 'v1', name: 'Hall', city: 'Hyderabad' },
        { id: 'v2', name: 'Arena', city: 'Boise' },
      ],
      [{ category: 'Sport' }, { category: 'Music' }, { category: 'Music' }, { category: '' }],
    );
    expect(opts.venues).toEqual([
      { id: 'v2', label: 'Arena, Boise' },
      { id: 'v1', label: 'Hall, Hyderabad' },
    ]);
    expect(opts.categories).toEqual(['Music', 'Sport']);
  });
});

describe('from the API', () => {
  function row(over: Partial<OrganizerCalendarSession> = {}): OrganizerCalendarSession {
    return {
      id: 's1',
      startsAt: '2026-11-06T13:30:00.000Z',
      endsAt: '2026-11-06T16:30:00.000Z',
      status: 'SCHEDULED',
      event: {
        id: 'e1',
        title: 'Concert',
        category: 'Music',
        status: 'PUBLISHED',
        experienceType: 'EVENT',
      },
      venue: { id: 'v1', name: 'Hall', city: 'Hyderabad', country: 'IN', timezone: null },
      cinemaTimezone: null,
      sold: 15,
      capacity: 150,
      ...over,
    };
  }

  it('places a session in its venue zone, or its country only zone', () => {
    const [s] = toCalendarSessions([row()]);
    // India has one zone, so a venue with none set is still placed in IST.
    expect([s.zone, s.zoneKnown, s.sold, s.capacity, s.eventStatus]).toEqual([
      'Asia/Kolkata',
      true,
      15,
      150,
      'PUBLISHED',
    ]);
    const [boise] = toCalendarSessions([
      row({
        venue: {
          id: 'v2',
          name: 'Arena',
          city: 'Boise',
          country: 'US',
          timezone: 'America/Boise',
        },
      }),
    ]);
    expect(boise.zone).toBe('America/Boise');
  });

  it('places a film show in its cinema zone, and nothing else', () => {
    const film = row({
      event: {
        id: 'e',
        title: 'Film',
        category: 'Film',
        status: 'PUBLISHED',
        experienceType: 'MOVIE',
      },
      venue: { id: 'v', name: 'Plex', city: 'Toronto', country: 'CA', timezone: null },
      cinemaTimezone: 'America/Toronto',
    });
    expect(sessionZone(film)).toEqual({ zone: 'America/Toronto', known: true });
    // A seated concert in a room that happens to belong to a cinema keeps its venue zone.
    const concert = row({
      venue: { id: 'v', name: 'Hall', city: 'Boise', country: 'US', timezone: 'America/Boise' },
      cinemaTimezone: 'Asia/Kolkata',
    });
    expect(sessionZone(concert).zone).toBe('America/Boise');
  });

  it('flags a multi-zone country with no venue zone as a guess', () => {
    const unknown = row({
      venue: { id: 'v', name: 'Hall', city: 'Somewhere', country: 'US', timezone: null },
    });
    expect(sessionZone(unknown).known).toBe(false);
  });

  it('asks the API for a day either side, so every zone on the visible days is covered', () => {
    expect(fetchWindow({ from: '2026-09-28', to: '2026-11-08' })).toEqual({
      from: '2026-09-27T00:00:00.000Z',
      to: '2026-11-10T00:00:00.000Z',
    });
    // The earliest instant of 28 Sep anywhere (UTC+14) and the last of 8 Nov (UTC-12) are inside.
    const w = fetchWindow({ from: '2026-09-28', to: '2026-11-08' });
    expect(Date.parse(w.from)).toBeLessThanOrEqual(Date.parse('2026-09-27T10:00:00Z'));
    expect(Date.parse(w.to)).toBeGreaterThanOrEqual(Date.parse('2026-11-09T12:00:00Z'));
  });
});

describe('status words', () => {
  it('names the event status, unless the session itself was stopped', () => {
    expect(displayStatus({ eventStatus: 'UNDER_REVIEW', sessionStatus: 'SCHEDULED' })).toEqual({
      status: 'UNDER_REVIEW',
      label: 'In review',
    });
    expect(displayStatus({ eventStatus: 'PUBLISHED', sessionStatus: 'CANCELLED' })).toEqual({
      status: 'CANCELLED',
      label: 'Session cancelled',
    });
    expect(displayStatus({ eventStatus: 'PUBLISHED', sessionStatus: 'COMPLETED' }).label).toBe(
      'Published',
    );
  });
});

describe('bounded rendering and defaults', () => {
  it('caps a day and counts what is hidden', () => {
    expect(capItems([1, 2, 3, 4, 5], 3)).toEqual({ shown: [1, 2, 3], hidden: 2 });
    expect(capItems([1, 2], 3)).toEqual({ shown: [1, 2], hidden: 0 });
  });

  it('opens on the agenda below 768px and on the month above', () => {
    expect(defaultViewFor(320)).toBe('agenda');
    expect(defaultViewFor(767)).toBe('agenda');
    expect(defaultViewFor(768)).toBe('month');
  });

  it('offers Create event to owners, managers and platform admins only', () => {
    expect(canCreateEvents('ORGANIZER_OWNER')).toBe(true);
    expect(canCreateEvents('ORGANIZER_MANAGER')).toBe(true);
    expect(canCreateEvents(null)).toBe(true);
    expect(canCreateEvents(undefined)).toBe(true);
    expect(canCreateEvents('CHECKIN_STAFF')).toBe(false);
  });
});

describe('the status vocabulary', () => {
  it('uses the console words, the same as the admin calendar', () => {
    expect(statusText('UNDER_REVIEW')).toBe('In review');
    expect(statusText('COMPLETED')).toBe('Ended');
    expect(statusText('SOLD_OUT')).toBe('Sold out');
    expect(statusText('SOMETHING_NEW')).toBe('Something new');
  });

  it('never draws an unknown status as green', () => {
    expect(statusTone('PUBLISHED')).toBe('success');
    expect(statusTone('UNDER_REVIEW')).toBe('warning');
    expect(statusTone('CANCELLED')).toBe('error');
    expect(statusTone('SOMETHING_NEW')).toBe('neutral');
  });
});
