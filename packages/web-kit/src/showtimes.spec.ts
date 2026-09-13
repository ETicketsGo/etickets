import { describe, expect, it } from 'vitest';
import type { PublicShowRow } from './api';
import {
  addCalendarDays,
  applyShowtimeFilters,
  buildDateStrip,
  countByTimeOfDay,
  dateWindows,
  dayLabelParts,
  defaultShowDate,
  groupShowtimesByCinema,
  hasActiveShowtimeFilters,
  isBookable,
  isLateNight,
  localClock,
  NO_SHOWTIME_FILTERS,
  preferredDay,
  resolveShowDate,
  rowsOnDate,
  safeTimeZone,
  showLocalDate,
  showtimeLabel,
  timeOfDay,
  windowFor,
} from './showtimes';

const IST = 'Asia/Kolkata';

let seq = 0;
/** A screening at a Hyderabad cinema, starting at `local` IST on `date`. */
function show(over: Partial<PublicShowRow> & { at?: string } = {}): PublicShowRow {
  seq += 1;
  const { at = '2026-09-13T18:30', ...rest } = over;
  const startsAt = new Date(`${at}:00+05:30`).toISOString();
  return {
    sessionId: `s${String(seq).padStart(3, '0')}`,
    eventId: 'e1',
    eventSlug: 'skyfront',
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + 2 * 3_600_000).toISOString(),
    venue: { id: 'v1', name: 'Nexus Mall', city: 'Hyderabad', country: 'IN' },
    cinema: { id: 'c1', name: 'Aurora Cinemas', brand: null, timezone: IST },
    localDate: at.slice(0, 10),
    screen: { id: 'sc1', name: 'Screen 1' },
    format: '2D',
    language: 'Telugu',
    currency: 'INR',
    fromPriceMinor: 18_000,
    seatingType: 'RESERVED',
    availability: 'AVAILABLE',
    seatsAvailable: 100,
    seatsTotal: 120,
    ...rest,
  };
}

describe('the clock is the cinema’s', () => {
  it('reads the wall clock in the given zone, date included', () => {
    // 18:30 UTC is 00:00 the next day in India.
    expect(localClock('2026-09-13T18:30:00Z', IST)).toEqual({
      date: '2026-09-14',
      hour: 0,
      minute: 0,
    });
  });

  it('survives a zone Intl does not know', () => {
    // An organizer's typo must cost the offset, not the page.
    expect(safeTimeZone('Asia/Hyderabad')).toBeUndefined();
    expect(() => localClock('2026-09-13T18:30:00Z', 'Asia/Hyderabad')).not.toThrow();
    expect(safeTimeZone(IST)).toBe(IST);
  });

  it('files a show under its server-given local date, never the UTC date', () => {
    // 00:30 IST on the 14th is still the 13th in UTC.
    const lateShow = show({ at: '2026-09-14T00:30' });
    expect(lateShow.startsAt.slice(0, 10)).toBe('2026-09-13');
    expect(showLocalDate(lateShow)).toBe('2026-09-14');
  });

  it('derives the local date in the cinema zone when the server gave none', () => {
    expect(showLocalDate(show({ at: '2026-09-14T00:30', localDate: null }))).toBe('2026-09-14');
  });
});

describe('timeOfDay', () => {
  it.each([
    ['2026-09-13T00:00', 'MORNING'],
    ['2026-09-13T11:59', 'MORNING'],
    ['2026-09-13T12:00', 'AFTERNOON'],
    ['2026-09-13T15:59', 'AFTERNOON'],
    ['2026-09-13T16:00', 'EVENING'],
    ['2026-09-13T18:59', 'EVENING'],
    ['2026-09-13T19:00', 'NIGHT'],
    ['2026-09-13T23:59', 'NIGHT'],
  ])('%s IST is %s', (at, bucket) => {
    expect(timeOfDay(new Date(`${at}:00+05:30`), IST)).toBe(bucket);
  });

  it('buckets by the cinema zone, not the viewer’s', () => {
    const instant = '2026-09-13T14:00:00Z'; // 19:30 in India, 10:00 in Toronto
    expect(timeOfDay(instant, IST)).toBe('NIGHT');
    expect(timeOfDay(instant, 'America/Toronto')).toBe('MORNING');
  });
});

describe('isLateNight', () => {
  it.each([
    ['2026-09-13T22:59', false],
    ['2026-09-13T23:00', true],
    ['2026-09-14T00:30', true],
    ['2026-09-14T04:59', true],
    ['2026-09-14T05:00', false],
  ])('%s IST → %s', (at, expected) => {
    expect(isLateNight(new Date(`${at}:00+05:30`), IST)).toBe(expected);
  });
});

describe('isBookable', () => {
  it('sells available and limited shows only', () => {
    expect(isBookable('AVAILABLE')).toBe(true);
    expect(isBookable('LIMITED')).toBe(true);
    expect(isBookable('SOLD_OUT')).toBe(false);
    expect(isBookable('SALES_PAUSED')).toBe(false);
  });
});

describe('the date strip', () => {
  it('adds days across a month and a year end', () => {
    expect(addCalendarDays('2026-09-29', 3)).toBe('2026-10-02');
    expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addCalendarDays('2027-01-01', -1)).toBe('2026-12-31');
  });

  it('is seven consecutive days from the first day with a show, gaps kept', () => {
    const rows = [
      show({ at: '2026-09-30T10:00' }),
      show({ at: '2026-09-30T19:00', availability: 'SOLD_OUT' }),
      show({ at: '2026-10-03T19:00' }),
    ];
    const strip = buildDateStrip(rows);
    expect(strip.map((d) => d.date)).toEqual([
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
      '2026-10-06',
    ]);
    expect(strip[0]).toEqual({ date: '2026-09-30', shows: 2, bookable: 1 });
    expect(strip[1]).toEqual({ date: '2026-10-01', shows: 0, bookable: 0 });
    expect(strip[3]).toEqual({ date: '2026-10-03', shows: 1, bookable: 1 });
  });

  it('is empty when nothing is on', () => {
    expect(buildDateStrip([])).toEqual([]);
    expect(defaultShowDate([])).toBeNull();
    expect(dateWindows([])).toEqual([]);
  });

  it('groups a past-midnight show under the cinema’s next day', () => {
    const strip = buildDateStrip([
      show({ at: '2026-09-13T21:00' }),
      show({ at: '2026-09-14T00:30' }),
    ]);
    expect(strip[0]).toMatchObject({ date: '2026-09-13', shows: 1 });
    expect(strip[1]).toMatchObject({ date: '2026-09-14', shows: 1 });
  });

  it('pages so every show day is on exactly one page', () => {
    const rows = [
      show({ at: '2026-09-13T10:00' }),
      show({ at: '2026-09-19T10:00' }),
      show({ at: '2026-09-20T10:00' }), // 13 + 7: the next page
      show({ at: '2027-02-10T10:00' }), // months later: a page of its own, not twenty empty ones
    ];
    expect(dateWindows(rows)).toEqual(['2026-09-13', '2026-09-20', '2027-02-10']);
    expect(windowFor(rows, '2026-09-19')).toBe('2026-09-13');
    expect(windowFor(rows, '2026-09-26')).toBe('2026-09-20');
    expect(windowFor(rows, '2027-02-10')).toBe('2027-02-10');
    expect(windowFor(rows, '2026-12-01')).toBeNull();
    expect(buildDateStrip(rows, { start: '2027-02-10' })[0]).toMatchObject({ shows: 1 });
  });
});

describe('the day the page opens on', () => {
  it('skips a first day that is entirely sold out', () => {
    const rows = [
      show({ at: '2026-09-13T10:00', availability: 'SOLD_OUT' }),
      show({ at: '2026-09-13T19:00', availability: 'SALES_PAUSED' }),
      show({ at: '2026-09-14T19:00', availability: 'LIMITED' }),
    ];
    expect(defaultShowDate(rows)).toBe('2026-09-14');
  });

  it('falls back to the first day when nothing at all can be booked', () => {
    const rows = [
      show({ at: '2026-09-15T10:00', availability: 'SOLD_OUT' }),
      show({ at: '2026-09-13T10:00', availability: 'SOLD_OUT' }),
    ];
    expect(defaultShowDate(rows)).toBe('2026-09-13');
  });

  it('keeps a picked day only while it still has shows', () => {
    const rows = [show({ at: '2026-09-13T10:00' }), show({ at: '2026-09-15T10:00' })];
    expect(resolveShowDate(rows, '2026-09-15')).toBe('2026-09-15');
    // e.g. the city changed and that day is gone.
    expect(resolveShowDate(rows, '2026-09-14')).toBe('2026-09-13');
    expect(resolveShowDate(rows, null)).toBe('2026-09-13');
  });

  it('prefers a bookable day within a page', () => {
    expect(
      preferredDay([
        { date: '2026-09-20', shows: 0, bookable: 0 },
        { date: '2026-09-21', shows: 2, bookable: 0 },
        { date: '2026-09-22', shows: 1, bookable: 1 },
      ]),
    ).toBe('2026-09-22');
    expect(preferredDay([{ date: '2026-09-20', shows: 0, bookable: 0 }])).toBeNull();
  });

  it('lists only the rows on a day', () => {
    const rows = [show({ at: '2026-09-13T10:00' }), show({ at: '2026-09-14T00:30' })];
    expect(rowsOnDate(rows, '2026-09-14')).toEqual([rows[1]]);
    expect(rowsOnDate(rows, null)).toEqual([]);
  });
});

describe('filters', () => {
  const rows = [
    show({ at: '2026-09-13T10:00', format: '2D' }),
    show({ at: '2026-09-13T13:00', format: 'IMAX' }),
    show({ at: '2026-09-13T17:00', format: '3D' }),
    show({ at: '2026-09-13T21:00', format: 'IMAX' }),
    show({ at: '2026-09-13T21:30', format: null }),
  ];

  it('lets everything through when nothing is chosen', () => {
    expect(hasActiveShowtimeFilters(NO_SHOWTIME_FILTERS)).toBe(false);
    expect(applyShowtimeFilters(rows, NO_SHOWTIME_FILTERS)).toEqual(rows);
  });

  it('ORs within a group', () => {
    const out = applyShowtimeFilters(rows, { formats: ['IMAX', '3D'], times: [] });
    expect(out.map((r) => r.format)).toEqual(['IMAX', '3D', 'IMAX']);
  });

  it('ANDs across groups, in the cinema’s local time', () => {
    const filters = { formats: ['IMAX'], times: ['NIGHT' as const] };
    expect(hasActiveShowtimeFilters(filters)).toBe(true);
    expect(applyShowtimeFilters(rows, filters)).toEqual([rows[3]]);
  });

  it('never matches a show with no format to a format filter', () => {
    expect(applyShowtimeFilters(rows, { formats: ['2D'], times: ['NIGHT'] })).toEqual([]);
  });

  it('counts each part of the day', () => {
    expect(countByTimeOfDay(rows)).toEqual({ MORNING: 1, AFTERNOON: 1, EVENING: 1, NIGHT: 2 });
  });
});

describe('groupShowtimesByCinema', () => {
  const aurora = { id: 'c1', name: 'Aurora Cinemas', brand: null, timezone: IST };
  const bayview = { id: 'c2', name: 'bayview Multiplex', brand: 'Bay', timezone: IST };
  const rows = [
    show({ at: '2026-09-13T21:00', cinema: bayview, sessionId: 'b2' }),
    show({ at: '2026-09-13T10:00', cinema: aurora, sessionId: 'a1' }),
    show({ at: '2026-09-13T21:00', cinema: bayview, sessionId: 'b1' }),
    show({ at: '2026-09-14T10:00', cinema: aurora, sessionId: 'a2' }),
    show({
      at: '2026-09-13T12:00',
      cinema: null,
      venue: { id: 'v9', name: 'Community Hall', city: 'Hyderabad', country: 'IN' },
      sessionId: 'h1',
    }),
  ];

  it('orders cinemas by name, case-insensitively, and shows by time then id', () => {
    const groups = groupShowtimesByCinema(rows, { date: '2026-09-13' });
    expect(groups.map((g) => g.name)).toEqual([
      'Aurora Cinemas',
      'bayview Multiplex',
      'Community Hall',
    ]);
    expect(groups[1].shows.map((s) => s.sessionId)).toEqual(['b1', 'b2']);
    expect(groups[1].brand).toBe('Bay');
  });

  it('narrows to the day', () => {
    const aur = groupShowtimesByCinema(rows, { date: '2026-09-13' })[0];
    expect(aur.shows.map((s) => s.sessionId)).toEqual(['a1']);
    expect(groupShowtimesByCinema(rows).find((g) => g.key === 'cinema:c1')?.shows).toHaveLength(2);
  });

  it('puts favourites first', () => {
    const groups = groupShowtimesByCinema(rows, {
      date: '2026-09-13',
      favourites: ['venue:v9', 'cinema:c2'],
    });
    expect(groups.map((g) => g.key)).toEqual(['cinema:c2', 'venue:v9', 'cinema:c1']);
    expect(groups.map((g) => g.favourite)).toEqual([true, true, false]);
  });

  it('keys a cinemaless row by its venue, shown in the browser zone', () => {
    const hall = groupShowtimesByCinema(rows).find((g) => g.name === 'Community Hall');
    expect(hall?.key).toBe('venue:v9');
    expect(hall?.timeZone).toBeUndefined();
  });

  it('does not reorder its input', () => {
    const before = rows.map((r) => r.sessionId);
    groupShowtimesByCinema(rows);
    expect(rows.map((r) => r.sessionId)).toEqual(before);
  });
});

describe('labels', () => {
  const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

  it('keeps the English 12-hour clock in the cinema zone', () => {
    expect(squash(showtimeLabel('2026-09-13T13:00:00Z', { timeZone: IST }))).toMatch(/^6:30 pm$/i);
  });

  it('gives French its 24-hour clock', () => {
    expect(
      squash(showtimeLabel('2026-09-13T13:00:00Z', { timeZone: IST, locale: 'fr-CA' })),
    ).toMatch(/^18 h 30$/);
  });

  it('names a tile’s day without moving it through a zone', () => {
    const parts = dayLabelParts('2026-09-13');
    expect(parts.weekday).toBe('Sun');
    expect(parts.day).toBe('13');
    expect(parts.month).toMatch(/^Sep/);
    expect(parts.full).toMatch(/Sunday/);
    expect(dayLabelParts('2026-09-13', 'fr-CA').full).toMatch(/dimanche/);
  });
});
