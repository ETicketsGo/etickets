import { describe, expect, it } from 'vitest';
import {
  bookingWindowState,
  describeBookingWindow,
  effectiveShowBadge,
  formatDayHeading,
  formatLocalTime,
  localDateOf,
  weekDates,
} from './show-status';

/**
 * Unit coverage for the scheduling workspace's presentation rules.
 *
 * These exist because the Playwright suite CANNOT reach the cases that matter most here.
 * The sales-window boundary is defined at `now === salesEndAt`, and no browser test can put
 * the clock exactly on that instant — it can only bracket it and hope. The timezone rules
 * are the same story: proving a Kolkata show buckets correctly in five zones takes five
 * browser contexts and two minutes, or one file and a few milliseconds.
 *
 * The boundary rule is not a preference. Booking creation refuses on `salesEndAt < now`, so
 * a show is still sellable AT its close instant. A workspace that said "closed" a moment
 * early would be turning customers away that the server would have served, which is the
 * class of inconsistency already fixed once on the public side.
 */

const IST = 'Asia/Kolkata';

/** Minimal row shape; only the fields the window rules read. */
const show = (
  over: Partial<{ status: string; salesStartAt: string | null; salesEndAt: string | null }> = {},
) => ({
  status: 'SCHEDULED',
  salesStartAt: null,
  salesEndAt: null,
  ...over,
});

describe('bookingWindowState', () => {
  const now = new Date('2026-08-08T12:00:00Z');

  it('is on sale with no window at all', () => {
    // An unbounded window is the common case: most shows sell until they play.
    expect(bookingWindowState(show(), now)).toBe('ON_SALE');
  });

  it('is not open before the start instant', () => {
    expect(bookingWindowState(show({ salesStartAt: '2026-08-08T12:00:01Z' }), now)).toBe(
      'SALES_NOT_OPEN',
    );
  });

  it('is on sale exactly AT the start instant', () => {
    // Open is inclusive: the server rejects on `salesStartAt > now`, so equal is allowed.
    expect(bookingWindowState(show({ salesStartAt: '2026-08-08T12:00:00Z' }), now)).toBe('ON_SALE');
  });

  it('is on sale exactly AT the close instant', () => {
    // The boundary this whole file exists for. `salesEndAt < now` is the server's rule, so
    // at equality the show is still sellable and must not be reported closed.
    expect(bookingWindowState(show({ salesEndAt: '2026-08-08T12:00:00Z' }), now)).toBe('ON_SALE');
  });

  it('is closed one millisecond after the close instant', () => {
    expect(bookingWindowState(show({ salesEndAt: '2026-08-08T11:59:59.999Z' }), now)).toBe(
      'BOOKING_CLOSED',
    );
  });

  it('reports a manual pause rather than the window', () => {
    // A pause is something a person did and a person undoes. Reporting it as a closed
    // window would send the operator looking for a clock problem that does not exist.
    expect(
      bookingWindowState(show({ status: 'PAUSED', salesEndAt: '2026-08-08T11:00:00Z' }), now),
    ).toBe('SALES_PAUSED');
  });

  it('reports cancellation ahead of everything else', () => {
    expect(
      bookingWindowState(show({ status: 'CANCELLED', salesStartAt: '2027-01-01T00:00:00Z' }), now),
    ).toBe('CANCELLED');
  });

  it('reports a completed show as finished', () => {
    expect(bookingWindowState(show({ status: 'COMPLETED' }), now)).toBe('FINISHED');
  });

  it('accepts lowercase status from the API without changing meaning', () => {
    expect(bookingWindowState(show({ status: 'paused' }), now)).toBe('SALES_PAUSED');
  });
});

describe('describeBookingWindow', () => {
  const now = new Date('2026-08-08T12:00:00Z');

  it('names the opening time in the CINEMA zone, not UTC', () => {
    // 2026-08-09T03:30:00Z is 09:00 on the 9th in Kolkata. An operator told "03:30" would
    // open the counter five and a half hours late.
    const state = bookingWindowState(show({ salesStartAt: '2026-08-09T03:30:00Z' }), now);
    const described = describeBookingWindow(state, { salesStartAt: '2026-08-09T03:30:00Z' }, IST);
    expect(described.label).toBe('Not open yet');
    expect(described.hint).toContain('09:00');
    expect(described.hint).toContain('9 Aug');
  });

  it('every state has a non-empty label and hint', () => {
    // A badge with no words is a colour swatch, and colour alone is not an accessible state.
    const states = [
      'ON_SALE',
      'SALES_NOT_OPEN',
      'BOOKING_CLOSED',
      'SALES_PAUSED',
      'CANCELLED',
      'FINISHED',
    ] as const;
    for (const s of states) {
      const d = describeBookingWindow(s, {}, IST);
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.hint.length).toBeGreaterThan(0);
    }
  });

  it('distinguishes a paused show from a closed window in words', () => {
    // These are different situations with different remedies, so they must not share text.
    const paused = describeBookingWindow('SALES_PAUSED', {}, IST);
    const closed = describeBookingWindow('BOOKING_CLOSED', {}, IST);
    expect(paused.label).not.toBe(closed.label);
  });
});

describe('effectiveShowBadge', () => {
  const now = new Date('2026-08-08T12:00:00Z');

  it('gives ONE answer that folds the window into the lifecycle', () => {
    // The regression this function was written for: a SCHEDULED show past its close was
    // rendering two badges reading "On sale" and "Booking closed" side by side.
    const badge = effectiveShowBadge(
      show({ status: 'SCHEDULED', salesEndAt: '2026-08-08T11:00:00Z' }),
      now,
      IST,
    );
    expect(badge.label).toBe('Booking closed');
  });

  it('says on sale for a scheduled show inside its window', () => {
    expect(effectiveShowBadge(show({ salesEndAt: '2026-08-08T13:00:00Z' }), now, IST).label).toBe(
      'On sale',
    );
  });

  it('renders an unrecognised status as itself rather than claiming it is on sale', () => {
    // When a newer API adds a state, an out-of-date screen must say something honest and
    // unfamiliar. Defaulting to "On sale" would be confident and wrong.
    const badge = effectiveShowBadge(show({ status: 'RESCHEDULING' }), now, IST);
    expect(badge.label).toBe('RESCHEDULING');
    expect(badge.tone).toBe('neutral');
  });
});

describe('local date and time rendering', () => {
  it('buckets a post-midnight Kolkata show on its own local date', () => {
    // 00:30 IST is 19:00 the PREVIOUS day in UTC. This is the bug that has appeared twice.
    expect(localDateOf('2026-11-17T19:00:00Z', IST)).toBe('2026-11-18');
  });

  it('gives the same instant different local dates in different zones', () => {
    const instant = '2026-11-17T19:00:00Z';
    expect(localDateOf(instant, IST)).toBe('2026-11-18');
    expect(localDateOf(instant, 'UTC')).toBe('2026-11-17');
    expect(localDateOf(instant, 'America/Los_Angeles')).toBe('2026-11-17');
  });

  it('renders 24-hour cinema-local time regardless of the running machine', () => {
    expect(formatLocalTime('2026-11-17T19:00:00Z', IST)).toBe('00:30');
    expect(formatLocalTime('2026-08-08T12:00:00Z', IST)).toBe('17:30');
  });

  it('survives a DST market where a fixed offset would not', () => {
    // New York is UTC-4 in August and UTC-5 in December. Hard-coded offsets break here.
    expect(formatLocalTime('2026-08-08T12:00:00Z', 'America/New_York')).toBe('08:00');
    expect(formatLocalTime('2026-12-08T12:00:00Z', 'America/New_York')).toBe('07:00');
  });
});

describe('weekDates', () => {
  it('returns seven consecutive days starting on Monday', () => {
    // 2026-08-08 is a Saturday; its week starts on the 3rd.
    expect(weekDates('2026-08-08')).toEqual([
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
      '2026-08-06',
      '2026-08-07',
      '2026-08-08',
      '2026-08-09',
    ]);
  });

  it('treats Sunday as the END of its week, not the start', () => {
    // The off-by-one that puts a Sunday show in next week's column.
    expect(weekDates('2026-08-09')[0]).toBe('2026-08-03');
    expect(weekDates('2026-08-09')[6]).toBe('2026-08-09');
  });

  it('is stable when the anchor is already a Monday', () => {
    expect(weekDates('2026-08-03')[0]).toBe('2026-08-03');
  });

  it('crosses a month boundary without arithmetic drift', () => {
    expect(weekDates('2026-09-01')).toEqual([
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
      '2026-09-06',
    ]);
  });

  it('formats a heading from the label alone, with no zone shift', () => {
    // Headings are label arithmetic. Formatting them through a local Date would slide the
    // whole week by a day for anyone west of UTC.
    expect(formatDayHeading('2026-08-03')).toContain('3 Aug');
    expect(formatDayHeading('2026-08-03')).toContain('Mon');
  });
});
