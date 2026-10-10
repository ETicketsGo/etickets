import { venueZone } from '@eticketsgo/shared-types';
import { localDate } from './event-list-model';

/**
 * The events list's month view, as data: which days a month grid shows, and which sessions
 * fall on each. No React, so every rule is tested as a value.
 *
 * Sessions come from `GET /organizer-calendar` (every session of the organization in a range),
 * not from the list rows - a row carries only its first, next and last session, and a month
 * drawn from those would leave out every show in between.
 */

export interface CalendarSessionLike {
  id: string;
  startsAt: string;
  status: string;
  event: { id: string };
  venue: { timezone: string | null; country: string | null };
  /** The zone of the cinema a seated session's room belongs to; null for general admission. */
  cinemaTimezone?: string | null;
}

/** "2026-10" for the month an instant falls in, on this device's calendar. */
export function monthKeyOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** The month `n` months after `key` (negative for before). */
export function shiftMonth(key: string, n: number): string {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** "October 2026". */
export function monthTitle(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, 1)));
}

export interface DayCell {
  /** YYYY-MM-DD. */
  date: string;
  day: number;
  inMonth: boolean;
}

/**
 * The days a month grid shows: whole weeks from Sunday, starting on or before the 1st and
 * ending on or after the last day. Five rows for most months, six when the month needs them,
 * never a padded sixth row of next month's days.
 */
export function monthCells(key: string): DayCell[] {
  const [y, m] = key.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = first.getUTCDay();
  const total = Math.ceil((lead + days) / 7) * 7;
  const cells: DayCell[] = [];
  for (let i = 0; i < total; i++) {
    const d = new Date(Date.UTC(y, m - 1, 1 - lead + i));
    cells.push({
      date: d.toISOString().slice(0, 10),
      day: d.getUTCDate(),
      inMonth: d.getUTCMonth() === m - 1,
    });
  }
  return cells;
}

/**
 * The instants to ask the API for: the month, widened by a day each side.
 *
 * A session's DAY is its day at the venue, and a venue can be up to 14 hours either side of
 * UTC, so a 1 a.m. show in Kolkata on the 1st starts on the 31st in UTC. The extra day each
 * side catches it; `sessionsByDay` then keeps only the days the grid draws. 33 days, inside
 * the API's 62-day cap.
 */
export function monthRange(key: string): { from: string; to: string } {
  const [y, m] = key.split('-').map(Number);
  return {
    from: new Date(Date.UTC(y, m - 1, 0)).toISOString(),
    to: new Date(Date.UTC(y, m, 2)).toISOString(),
  };
}

/** The zone a session's day is counted in: its cinema's, else its venue's. */
export function sessionZone(s: CalendarSessionLike): string | undefined {
  return s.cinemaTimezone || venueZone(s.venue.timezone, s.venue.country) || undefined;
}

/**
 * The sessions on each day, in start order, for the events the list's filters kept.
 *
 * Cancelled shows are left out: a dot under a day says something is ON. `keep` is the set of
 * event ids the other filters let through, so search, status, venue and category narrow the
 * month exactly as they narrow the cards.
 */
export function sessionsByDay<T extends CalendarSessionLike>(
  sessions: T[],
  keep: Set<string> | null,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  const sorted = [...sessions].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  for (const s of sorted) {
    if (s.status === 'CANCELLED') continue;
    if (keep && !keep.has(s.event.id)) continue;
    const day = localDate(s.startsAt, sessionZone(s));
    const list = out.get(day);
    if (list) list.push(s);
    else out.set(day, [s]);
  }
  return out;
}
