import { describe, expect, it } from 'vitest';
import { formatDayHeading, formatLocalTime, localDateOf, weekDates } from './show-status';

/**
 * Unit coverage for the scheduling workspace's presentation rules.
 *
 * These exist because the Playwright suite cannot reach them cheaply: proving a Kolkata show
 * buckets correctly in five zones takes five browser contexts and two minutes, or one file
 * and a few milliseconds.
 *
 * The booking-window badge rules ("On sale", "Not open yet", "Booking closed") used to be
 * tested here too. The page no longer works a show's sale state out from its window: it
 * shows the server's unified state, from the rule checkout refuses with, and that rule is
 * tested where it lives (shared-types `sale-state`).
 */

const IST = 'Asia/Kolkata';

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
