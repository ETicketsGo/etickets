import { describe, expect, it } from 'vitest';
import {
  NO_FILTERS,
  approvalOf,
  filterBySale,
  filterEvents,
  filterOptions,
  imageCategoryOf,
  localDate,
  parseView,
  scheduleSummary,
  sellingStateOf,
  soldOfCapacity,
  sortEvents,
  timeAtVenue,
  type EventListRow,
} from './event-list-model';

const KOLKATA = { name: 'Hall', city: 'Pune', country: 'India', timezone: 'Asia/Kolkata' };
const CHICAGO = { name: 'Arena', city: 'Chicago', country: 'US', timezone: 'America/Chicago' };

function row(over: Partial<EventListRow> & { id: string }): EventListRow {
  return {
    title: over.id,
    slug: over.id,
    category: 'Music',
    status: 'PUBLISHED',
    createdAt: '2026-01-01T00:00:00.000Z',
    venueId: 'v-hall',
    venue: KOLKATA,
    _count: { sessions: 0, bookings: 0 },
    ...over,
  };
}

describe('approvalOf', () => {
  it('reads approval apart from status', () => {
    expect(approvalOf({ status: 'UNDER_REVIEW' }).label).toBe('Awaiting approval');
    expect(approvalOf({ status: 'DRAFT' }).label).toBe('Not submitted');
    // Sent back: a draft carrying the reviewer's note and never published.
    expect(approvalOf({ status: 'DRAFT', reviewNote: 'Fix the poster' })).toEqual({
      label: 'Changes requested',
      tone: 'error',
    });
    expect(approvalOf({ status: 'PUBLISHED', publishedAt: '2026-01-01' }).label).toBe('Approved');
    // A paused event was approved; pausing is about sales, not review.
    expect(approvalOf({ status: 'PAUSED', publishedAt: '2026-01-01' }).label).toBe('Approved');
    expect(
      approvalOf({ status: 'PAUSED', publishedAt: '2026-01-01', pausedByAdmin: true }).label,
    ).toBe('Paused by platform');
    expect(
      approvalOf({ status: 'PAUSED', publishedAt: '2026-01-01', needsReviewOnResume: true }).label,
    ).toBe('Review needed to resume');
    expect(approvalOf({ status: 'CANCELLED' }).label).toBe('Never published');
  });
});

describe('timeAtVenue', () => {
  it('shows the time at the venue, with the zone named, whatever the reader is in', () => {
    // 14:00 UTC is 19:30 in Pune and 09:00 in Chicago (CDT).
    const at = '2026-10-14T14:00:00.000Z';
    // Each zone by the short name people use there, not an offset.
    expect(timeAtVenue(at, KOLKATA)).toMatch(/7:30\s?pm IST$/i);
    expect(timeAtVenue(at, CHICAGO)).toMatch(/9:00\s?am CDT$/i);
  });

  it('falls back to the only zone a country has', () => {
    expect(timeAtVenue('2026-10-14T14:00:00.000Z', { country: 'India', timezone: null })).toMatch(
      /IST$/,
    );
  });

  it('says so when it can only use the reader’s own zone', () => {
    expect(timeAtVenue('2026-10-14T14:00:00.000Z', { country: 'US', timezone: null })).toMatch(
      /\(your time\)$/,
    );
  });
});

describe('scheduleSummary', () => {
  it('names the next session and counts the others still to come', () => {
    const s = scheduleSummary(
      row({
        id: 'a',
        schedule: {
          firstStartsAt: '2026-01-01T14:00:00.000Z',
          lastStartsAt: '2026-12-01T14:00:00.000Z',
          nextStartsAt: '2026-10-14T14:00:00.000Z',
          upcomingSessions: 4,
        },
      }),
    );
    expect(s.lead).toBe('Next');
    expect(s.when).toMatch(/14 Oct 2026.*IST/);
    expect(s.more).toBe('+3 more sessions');
  });

  it('says "1 more session" in the singular and nothing when it is the only one', () => {
    const base = {
      firstStartsAt: '2026-10-14T14:00:00.000Z',
      lastStartsAt: '2026-10-15T14:00:00.000Z',
      nextStartsAt: '2026-10-14T14:00:00.000Z',
    };
    expect(scheduleSummary(row({ id: 'a', schedule: { ...base, upcomingSessions: 2 } })).more).toBe(
      '+1 more session',
    );
    expect(
      scheduleSummary(row({ id: 'a', schedule: { ...base, upcomingSessions: 1 } })).more,
    ).toBeNull();
  });

  it('names the last session of an event that is over', () => {
    const s = scheduleSummary(
      row({
        id: 'a',
        schedule: {
          firstStartsAt: '2025-01-01T14:00:00.000Z',
          lastStartsAt: '2025-02-01T14:00:00.000Z',
          nextStartsAt: null,
          upcomingSessions: 0,
        },
      }),
    );
    expect(s.lead).toBe('Last');
    expect(s.when).toMatch(/1 Feb 2025/);
  });

  it('says there are no sessions - including for an API that sends no schedule', () => {
    expect(scheduleSummary(row({ id: 'a' }))).toEqual({
      lead: null,
      when: 'No sessions yet',
      more: null,
    });
  });
});

describe('localDate', () => {
  it('is the calendar date at the venue, not in UTC', () => {
    // 20:00 UTC on the 14th is already the 15th in Pune and still the 14th in Chicago.
    expect(localDate('2026-10-14T20:00:00.000Z', 'Asia/Kolkata')).toBe('2026-10-15');
    expect(localDate('2026-10-14T20:00:00.000Z', 'America/Chicago')).toBe('2026-10-14');
  });
});

describe('filterEvents', () => {
  const span = (first: string, last: string) => ({
    firstStartsAt: first,
    lastStartsAt: last,
    nextStartsAt: null,
    upcomingSessions: 0,
  });
  const rows = [
    row({
      id: 'jazz',
      title: 'Jazz Night',
      category: 'Music',
      schedule: span('2026-10-10T14:00:00.000Z', '2026-10-12T14:00:00.000Z'),
    }),
    row({
      id: 'standup',
      title: 'Stand-up',
      category: 'Comedy',
      status: 'DRAFT',
      venueId: 'v-arena',
      venue: CHICAGO,
      schedule: span('2026-11-01T01:00:00.000Z', '2026-11-01T01:00:00.000Z'),
    }),
    row({ id: 'tbd', title: 'Not scheduled', category: 'Music' }),
  ];
  const ids = (list: EventListRow[]) => list.map((e) => e.id);

  it('passes everything with no filters', () => {
    expect(ids(filterEvents(rows, NO_FILTERS))).toEqual(['jazz', 'standup', 'tbd']);
  });

  it('searches title, venue and city, ignoring case', () => {
    expect(ids(filterEvents(rows, { ...NO_FILTERS, q: 'JAZZ' }))).toEqual(['jazz']);
    expect(ids(filterEvents(rows, { ...NO_FILTERS, q: 'chicago' }))).toEqual(['standup']);
  });

  it('filters by status, category and venue together', () => {
    expect(ids(filterEvents(rows, { ...NO_FILTERS, status: 'DRAFT' }))).toEqual(['standup']);
    expect(ids(filterEvents(rows, { ...NO_FILTERS, category: 'Music' }))).toEqual(['jazz', 'tbd']);
    expect(ids(filterEvents(rows, { ...NO_FILTERS, venue: 'v-hall', category: 'Music' }))).toEqual([
      'jazz',
      'tbd',
    ]);
    expect(
      ids(filterEvents(rows, { ...NO_FILTERS, venue: 'v-arena', status: 'PUBLISHED' })),
    ).toEqual([]);
  });

  it('keeps an event whose run overlaps the range, in the venue’s own calendar', () => {
    // Overlaps on the 12th only.
    expect(
      ids(filterEvents(rows, { ...NO_FILTERS, from: '2026-10-12', to: '2026-10-20' })),
    ).toEqual(['jazz']);
    expect(ids(filterEvents(rows, { ...NO_FILTERS, from: '2026-10-13' }))).toEqual(['standup']);
    /*
      01:00 UTC on 1 Nov is still 31 Oct in Chicago (CDT, UTC-5): a range ending on the 31st
      includes it. In UTC it would not - the defect a date filter on raw instants has.
    */
    expect(
      ids(filterEvents(rows, { ...NO_FILTERS, from: '2026-10-31', to: '2026-10-31' })),
    ).toEqual(['standup']);
  });

  it('leaves an event with no sessions out of any date range', () => {
    expect(ids(filterEvents(rows, { ...NO_FILTERS, to: '2030-01-01' }))).not.toContain('tbd');
  });
});

describe('sortEvents', () => {
  const sched = (next: string | null, last: string | null) => ({
    firstStartsAt: last,
    lastStartsAt: last,
    nextStartsAt: next,
    upcomingSessions: next ? 1 : 0,
  });
  const rows = [
    row({ id: 'b', title: 'Bravo', createdAt: '2026-02-01', schedule: sched(null, '2025-05-01') }),
    row({ id: 'a', title: 'Alpha', createdAt: '2026-03-01' }),
    row({
      id: 'c',
      title: 'Charlie',
      createdAt: '2026-01-01',
      schedule: sched('2026-12-01', '2026-12-01'),
    }),
    row({
      id: 'd',
      title: 'Delta',
      createdAt: '2026-04-01',
      schedule: sched('2026-11-01', '2026-12-01'),
    }),
  ];
  const ids = (list: EventListRow[]) => list.map((e) => e.id);

  it('orders by name, by newest, and never in place', () => {
    const copy = [...rows];
    expect(ids(sortEvents(rows, 'name'))).toEqual(['a', 'b', 'c', 'd']);
    expect(ids(sortEvents(rows, 'newest'))).toEqual(['d', 'a', 'b', 'c']);
    expect(rows).toEqual(copy);
  });

  it('puts the soonest next session first, then finished events, then unscheduled ones', () => {
    expect(ids(sortEvents(rows, 'date'))).toEqual(['d', 'c', 'b', 'a']);
  });

  it('orders by tickets sold', () => {
    const sold = [
      row({ id: 'x', tickets: { sold: 5, capacity: 10 } }),
      row({ id: 'y', tickets: { sold: 50, capacity: 100 } }),
      row({ id: 'z' }),
    ];
    expect(ids(sortEvents(sold, 'sold'))).toEqual(['y', 'x', 'z']);
  });

  it('never ranks amounts in two currencies against each other', () => {
    const money = [
      row({ id: 'inr-small', sales: [{ currency: 'INR', grossMinor: 60_000, bookings: 1 }] }),
      row({ id: 'usd', sales: [{ currency: 'USD', grossMinor: 50_000, bookings: 1 }] }),
      row({ id: 'none', sales: [] }),
      row({ id: 'inr-big', sales: [{ currency: 'INR', grossMinor: 90_000, bookings: 3 }] }),
      row({ id: 'hidden', sales: null }),
    ];
    // Grouped by currency, largest first within each; nothing sold (or not visible) last.
    expect(ids(sortEvents(money, 'gross'))).toEqual([
      'inr-big',
      'inr-small',
      'usd',
      'hidden',
      'none',
    ]);
  });
});

describe('filterOptions', () => {
  it('offers each venue once, named with its city, and each category once', () => {
    const opts = filterOptions([
      row({ id: '1', category: 'Music' }),
      row({ id: '2', category: 'Comedy', venueId: 'v-arena', venue: CHICAGO }),
      row({ id: '3', category: 'Music' }),
    ]);
    expect(opts.venues).toEqual([
      { value: 'v-arena', label: 'Arena, Chicago' },
      { value: 'v-hall', label: 'Hall, Pune' },
    ]);
    expect(opts.categories).toEqual(['Comedy', 'Music']);
  });
});

describe('soldOfCapacity', () => {
  it('reads sold against capacity, and never divides by zero', () => {
    expect(soldOfCapacity({ sold: 35, capacity: 150 })).toEqual({ label: '35 / 150', percent: 23 });
    expect(soldOfCapacity({ sold: 0, capacity: 0 })).toEqual({ label: '0 sold', percent: null });
    expect(soldOfCapacity(undefined)).toEqual({ label: '0 sold', percent: null });
  });
});

describe('parseView', () => {
  it('remembers the table and the calendar, and defaults to cards for anything else', () => {
    expect(parseView('table')).toBe('table');
    expect(parseView('calendar')).toBe('calendar');
    expect(parseView('cards')).toBe('cards');
    expect(parseView(null)).toBe('cards');
    expect(parseView('grid')).toBe('cards');
  });
});

describe('filterBySale', () => {
  const ids = (list: EventListRow[]) => list.map((e) => e.id);
  const rows = ['a', 'b', 'c', 'd'].map((id) => row({ id }));
  const states: Record<string, 'SELLING' | 'PARTIAL' | 'NOT_SELLING'> = {
    a: 'SELLING',
    b: 'PARTIAL',
    c: 'NOT_SELLING',
  };
  const stateOf = (id: string) => states[id];

  it('is a no-op with no sale filter, whatever has been answered', () => {
    expect(filterBySale(rows, '', stateOf)).toEqual({ rows, pending: 0 });
  });

  it('keeps only the events the server put in that state', () => {
    expect(ids(filterBySale(rows, 'SELLING', stateOf).rows)).toEqual(['a']);
    expect(ids(filterBySale(rows, 'PARTIAL', stateOf).rows)).toEqual(['b']);
    expect(ids(filterBySale(rows, 'NOT_SELLING', stateOf).rows)).toEqual(['c']);
  });

  it('never guesses an unanswered event into a bucket, and counts it as pending', () => {
    // "d" has no answer yet: not Selling, not Not selling - left out and counted.
    for (const sale of ['SELLING', 'PARTIAL', 'NOT_SELLING'] as const) {
      const out = filterBySale(rows, sale, stateOf);
      expect(ids(out.rows)).not.toContain('d');
      expect(out.pending).toBe(1);
    }
  });
});

describe('sellingStateOf', () => {
  const reason = (text: string) => ({
    code: 'SALES_ENDED' as const,
    text,
    message: `${text}.`,
    owner: 'ORGANIZER' as const,
    fixPath: null,
    ticketTypeIds: [],
    affectedSessions: 1,
  });

  it('is null with no answer - the caller says it is checking, never "Selling"', () => {
    expect(sellingStateOf(undefined)).toBeNull();
  });

  it('maps the three server states to the selling pill, with the lead reason', () => {
    expect(sellingStateOf({ state: 'SELLING', reasons: [] })).toEqual({ state: 'selling' });
    expect(
      sellingStateOf({ state: 'PARTIAL', reasons: [reason('Standard tickets are closed')] }),
    ).toEqual({ state: 'partly', reason: 'Standard tickets are closed' });
    expect(
      sellingStateOf({ state: 'NOT_SELLING', reasons: [reason('waiting for review')] }),
    ).toEqual({ state: 'not', reason: 'waiting for review' });
  });

  it('a partial answer with no reason still carries one - never a bare "Selling"', () => {
    const partial = sellingStateOf({ state: 'PARTIAL', reasons: [] });
    expect(partial).toEqual({ state: 'partly', reason: 'some tickets are closed' });
  });
});

describe('imageCategoryOf', () => {
  it('matches typed-in categories loosely, and falls back to a plain event', () => {
    expect(imageCategoryOf('Movie')).toBe('movie');
    expect(imageCategoryOf('Film festival')).toBe('movie');
    expect(imageCategoryOf('Music')).toBe('music');
    expect(imageCategoryOf('Comedy')).toBe('comedy');
    expect(imageCategoryOf('Sports')).toBe('sports');
    expect(imageCategoryOf('Tech')).toBe('conference');
    expect(imageCategoryOf('Workshop')).toBe('conference');
    expect(imageCategoryOf('Community')).toBe('event');
    expect(imageCategoryOf(null)).toBe('event');
  });
});
