import { zoneAbbrev } from '@eticketsgo/shared-types';

/**
 * The admin calendar's arithmetic: which days a view shows, which window to ask the API for,
 * and which day each session lands on.
 *
 * ── A SESSION'S DAY IS THE DAY AT THE VENUE ────────────────────────────────────────
 * A show at 00:30 on Saturday in Sydney is a Saturday show. In UTC it is Friday afternoon, and
 * in a browser in Hyderabad it is Friday evening - so placing it by either would put it on the
 * wrong day for everyone involved: the organizer, the buyers, and the admin trying to answer a
 * question about it. Every session is placed and timed in its own venue's zone, which the API
 * sends with it. Two sessions on one day of the grid can therefore be in different zones; each
 * one says which.
 *
 * A session whose venue has no recorded zone is placed in UTC and marked as such. It is never
 * given the launch market's zone: a guessed zone is how a Sydney show was once stored six hours
 * out.
 *
 * ── DAYS ARE STRINGS ───────────────────────────────────────────────────────────────
 * The grid is made of calendar days, `YYYY-MM-DD`, with no time and no zone. Arithmetic on them
 * is done at UTC noon, where adding a day can never be thrown off by a daylight-saving change in
 * the zone this code happens to run in.
 *
 * Pure: no React, no DOM, no clock unless one is passed in. `calendar.test.ts` covers it.
 */

export type CalendarView = 'month' | 'week' | 'agenda';

export const CALENDAR_VIEWS: CalendarView[] = ['month', 'week', 'agenda'];

/** How many days the agenda lists from its first day. */
export const AGENDA_DAYS = 14;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function atNoon(day: string): Date {
  return new Date(`${day}T12:00:00.000Z`);
}

/** A real calendar day, or null. "2026-02-30" is null, not 2 March. */
export function parseDay(raw: string | null | undefined): string | null {
  if (!raw || !DAY.test(raw)) return null;
  const d = atNoon(raw);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === raw ? raw : null;
}

export function parseView(raw: string | null | undefined): CalendarView {
  return raw === 'week' || raw === 'agenda' ? raw : 'month';
}

export function addDays(day: string, n: number): string {
  const d = atNoon(day);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Monday 0 ... Sunday 6. Weeks start on Monday, as they do in every launch market but one. */
export function weekdayIndex(day: string): number {
  return (atNoon(day).getUTCDay() + 6) % 7;
}

export function startOfWeek(day: string): string {
  return addDays(day, -weekdayIndex(day));
}

function firstOfMonth(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

function lastOfMonth(day: string): string {
  const d = atNoon(firstOfMonth(day));
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

/** Every day from `first` to `last`, both included. */
export function daysBetween(first: string, last: string): string[] {
  const out: string[] = [];
  for (let d = first; d <= last; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * The days a view draws.
 *
 * A month is drawn in whole weeks, Monday to Sunday, so its first and last rows include days of
 * the neighbouring months - and sessions on those days are fetched and shown too, because an
 * empty cell that is not actually empty is a lie the grid would be telling.
 */
export function viewDays(view: CalendarView, anchor: string): string[] {
  if (view === 'week') return daysBetween(startOfWeek(anchor), addDays(startOfWeek(anchor), 6));
  if (view === 'agenda') return daysBetween(anchor, addDays(anchor, AGENDA_DAYS - 1));
  const first = startOfWeek(firstOfMonth(anchor));
  const last = addDays(startOfWeek(lastOfMonth(anchor)), 6);
  return daysBetween(first, last);
}

/**
 * The UTC window to ask the API for: the drawn days plus one on each side.
 *
 * A venue's local day starts up to fourteen hours away from the UTC one, so a show early on the
 * first drawn day in Auckland, or late on the last one in Los Angeles, is stored on the UTC day
 * before or after. One day of padding covers every zone there is; the sessions it brings in that
 * fall outside the drawn days are dropped by `placeSessions`.
 */
export function fetchWindow(days: string[]): { from: string; to: string } {
  return { from: addDays(days[0], -1), to: addDays(days[days.length - 1], 1) };
}

/** Where the view moves on Previous / Next. */
export function shiftAnchor(view: CalendarView, anchor: string, dir: -1 | 1): string {
  if (view === 'week') return addDays(anchor, 7 * dir);
  if (view === 'agenda') return addDays(anchor, AGENDA_DAYS * dir);
  const d = atNoon(firstOfMonth(anchor));
  d.setUTCMonth(d.getUTCMonth() + dir);
  return d.toISOString().slice(0, 10);
}

/** Today in the reader's own zone, as a day. Used only to pick where the calendar opens. */
export function todayIn(now: Date, zone?: string): string {
  return localDay(now.toISOString(), zone ?? null) ?? now.toISOString().slice(0, 10);
}

function validZone(zone: string | null | undefined): string | null {
  if (!zone) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

/**
 * The calendar day an instant falls on in a zone, `YYYY-MM-DD`. UTC when the zone is null or not
 * one the browser knows - see `zoneNote` for how that is shown.
 */
export function localDay(iso: string, zone: string | null): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: validZone(zone) ?? 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * The wall-clock time at the venue, "7:30 PM".
 *
 * Newer ICU puts a narrow no-break space before AM/PM; it is replaced with a plain space so the
 * text is ASCII and wraps like the rest of the line.
 */
export function localTime(iso: string, zone: string | null): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: validZone(zone) ?? 'UTC',
    hour: 'numeric',
    minute: '2-digit',
  })
    .format(new Date(iso))
    .replace(/[  ]/g, ' ');
}

/** "IST", "GMT+13", or "UTC" for a session with no usable zone. */
export function zoneNote(iso: string, zone: string | null): string {
  const z = validZone(zone);
  if (!z) return 'UTC';
  return zoneAbbrev(iso, z) || z;
}

/** Whether a session is shown in UTC because its venue has no usable zone. */
export function zoneUnknown(zone: string | null): boolean {
  return validZone(zone) === null;
}

export interface PlaceableSession {
  id: string;
  startsAt: string;
  timezone: string | null;
  event: { title: string };
}

/**
 * The sessions on each drawn day, in the order a person reads a day: by the time on the venue's
 * clock, then by title so equal times do not shuffle between renders.
 *
 * Every drawn day has an entry, empty or not, so the grid never has to ask. Sessions whose local
 * day is outside the drawn days - the padding `fetchWindow` adds - are left out and counted.
 */
export function placeSessions<T extends PlaceableSession>(
  sessions: T[],
  days: string[],
): { byDay: Record<string, T[]>; outside: number } {
  const byDay: Record<string, T[]> = {};
  for (const d of days) byDay[d] = [];
  let outside = 0;
  const minuteOfDay = new Map<string, number>();
  for (const s of sessions) {
    const day = localDay(s.startsAt, s.timezone);
    if (!day || !(day in byDay)) {
      outside += 1;
      continue;
    }
    byDay[day].push(s);
    const [h, m] = new Intl.DateTimeFormat('en-GB', {
      timeZone: validZone(s.timezone) ?? 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .format(new Date(s.startsAt))
      .split(':')
      .map(Number);
    minuteOfDay.set(s.id, h * 60 + m);
  }
  for (const d of days) {
    byDay[d].sort(
      (a, b) =>
        (minuteOfDay.get(a.id) ?? 0) - (minuteOfDay.get(b.id) ?? 0) ||
        a.event.title.localeCompare(b.event.title) ||
        a.id.localeCompare(b.id),
    );
  }
  return { byDay, outside };
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function short(day: string): string {
  return `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1].slice(0, 3)}`;
}

/** The heading over the grid: "October 2026", or "5 Oct - 11 Oct 2026". */
export function rangeLabel(view: CalendarView, anchor: string, days: string[]): string {
  if (view === 'month') return `${MONTHS[Number(anchor.slice(5, 7)) - 1]} ${anchor.slice(0, 4)}`;
  const first = days[0];
  const last = days[days.length - 1];
  const sameYear = first.slice(0, 4) === last.slice(0, 4);
  return `${short(first)}${sameYear ? '' : ` ${first.slice(0, 4)}`} - ${short(last)} ${last.slice(0, 4)}`;
}

/** "Fri 9 Oct", for a day heading. */
export function dayLabel(day: string): string {
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return `${names[weekdayIndex(day)]} ${short(day)}`;
}

export const WEEKDAY_HEADINGS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** The cities in a set of sessions, for the city filter, "Hyderabad (IN)", sorted. */
export function cityOptions(
  sessions: { venue: { city: string; country: string | null } }[],
): { value: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const s of sessions) {
    const city = s.venue.city?.trim();
    if (!city) continue;
    const key = city.toLowerCase();
    if (!seen.has(key)) seen.set(key, s.venue.country ? `${city} (${s.venue.country})` : city);
  }
  return [...seen.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Sessions in one city, compared case-insensitively, as `cityOptions` keys them. */
export function inCity<T extends { venue: { city: string } }>(sessions: T[], city: string): T[] {
  if (!city) return sessions;
  return sessions.filter((s) => s.venue.city?.trim().toLowerCase() === city);
}
