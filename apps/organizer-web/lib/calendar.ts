import { marketFor } from '@eticketsgo/shared-types';
import type { OrganizerCalendarSession } from '@eticketsgo/web-kit';
import { venueInputZone } from './zoned-time';

/**
 * The organizer calendar's arithmetic, kept free of React so every rule here is testable.
 *
 * ── THE ONE RULE ────────────────────────────────────────────────────────────────────
 * A session is placed at the wall-clock time AT ITS VENUE, never in the browser's zone. A
 * 19:00 show in Hyderabad and a 19:00 show in Boise both sit in the 19:00 row of their own
 * date, each labelled with its zone. The calendar is a list of what happens where; converting
 * every show into the organizer's own clock would put a Hyderabad evening show in a Denver
 * morning, which is the defect `zoned-time.ts` exists to stop at input and which a calendar
 * must not bring back at output.
 *
 * So a calendar DAY here is a label, `YYYY-MM-DD`, not an instant. Day arithmetic is done on
 * labels at UTC midnight, where no day is 23 or 25 hours long; the zone only enters when an
 * instant from the API is turned into a label and a minute of that label's day.
 */

/** A calendar date as a label: `YYYY-MM-DD`. Never parsed through the browser's zone. */
export type DayKey = string;

export type CalendarView = 'month' | 'week' | 'day' | 'agenda';

/** 0 = Sunday, 1 = Monday. */
export type WeekStart = 0 | 1;

/**
 * The event statuses an organizer can filter on: the real `EventStatus` values, in the order
 * an event moves through them. ARCHIVED is left out - nothing in the console archives - so
 * offering it would be a filter that can only ever be empty.
 */
export const CALENDAR_STATUSES = [
  'DRAFT',
  'UNDER_REVIEW',
  'PUBLISHED',
  'PAUSED',
  'SOLD_OUT',
  'CANCELLED',
  'COMPLETED',
] as const;

/**
 * How a status reads on the calendar: its words and the tone of its dot and pill.
 *
 * The words are the console's lifecycle vocabulary (DESIGN-DIRECTION): "In review", not "Under
 * review"; COMPLETED is "Ended". PAUSED and SOLD_OUT keep their own words because they are what
 * the event row says, not a claim about sale eligibility - that comes only from the server's
 * unified eligibility, which the calendar does not read. The admin calendar's `lib/calendar.ts`
 * holds the same table, so a status looks the same in both consoles.
 */
export type StatusTone = 'success' | 'warning' | 'error' | 'info' | 'neutral';

const STATUS_LOOK: Record<string, { label: string; tone: StatusTone }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  UNDER_REVIEW: { label: 'In review', tone: 'warning' },
  PUBLISHED: { label: 'Published', tone: 'success' },
  PAUSED: { label: 'Paused', tone: 'warning' },
  SOLD_OUT: { label: 'Sold out', tone: 'info' },
  CANCELLED: { label: 'Cancelled', tone: 'error' },
  COMPLETED: { label: 'Ended', tone: 'neutral' },
  ARCHIVED: { label: 'Ended', tone: 'neutral' },
};

/** "In review", for a filter option or a status line. */
export function statusText(status: string): string {
  const known = STATUS_LOOK[status];
  if (known) return known.label;
  const words = status.toLowerCase().replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The tone a status is drawn in. A status this table does not know is neutral, never green. */
export function statusTone(status: string): StatusTone {
  return STATUS_LOOK[status]?.tone ?? 'neutral';
}

/**
 * The status a session is DRAWN with, and its words.
 *
 * The event's status, unless the session itself was cancelled or paused: a cancelled 21:00 show
 * inside a published event must not look like it is on sale. The filter still follows the
 * event's status, because that is the status an organizer manages.
 */
export function displayStatus(s: { eventStatus: string; sessionStatus: string }): {
  status: string;
  label: string;
} {
  if (s.sessionStatus === 'CANCELLED' || s.sessionStatus === 'PAUSED') {
    return { status: s.sessionStatus, label: `Session ${s.sessionStatus.toLowerCase()}` };
  }
  return { status: s.eventStatus, label: statusText(s.eventStatus) };
}

/** One session, with everything the calendar shows about it already resolved. */
export interface CalendarSession {
  /** The session id: unique, and what keys every rendered chip. */
  id: string;
  eventId: string;
  title: string;
  category: string;
  /** The EVENT's status - the one the filter and the colour follow. */
  eventStatus: string;
  /** The session's own status, shown only when it says something the event's does not. */
  sessionStatus: string;
  venueId: string;
  venueName: string;
  city: string;
  /** The IANA zone the session is placed in. */
  zone: string;
  /** False when the venue had no zone and its country has several: the browser's was used. */
  zoneKnown: boolean;
  startsAt: string;
  endsAt: string;
  /** Tickets sold and on sale, summed over the session's ticket types. Null when unknown. */
  sold: number | null;
  capacity: number | null;
}

/** One session's share of one calendar day. A multi-day session has one per day it touches. */
export interface DaySegment {
  session: CalendarSession;
  day: DayKey;
  /** Minutes after local midnight, 0..1440. */
  startMin: number;
  endMin: number;
  /** The session began on an earlier day. */
  continuesBefore: boolean;
  /** The session runs on into a later day. */
  continuesAfter: boolean;
}

const DAY_MS = 86_400_000;
const MINUTES_IN_DAY = 24 * 60;

// ─── Day labels ───

function keyToUtc(day: DayKey): Date {
  return new Date(`${day}T00:00:00Z`);
}

function utcToKey(d: Date): DayKey {
  return d.toISOString().slice(0, 10);
}

export function isDayKey(value: string | null | undefined): value is DayKey {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return utcToKey(keyToUtc(value)) === value;
}

export function addDays(day: DayKey, n: number): DayKey {
  return utcToKey(new Date(keyToUtc(day).getTime() + n * DAY_MS));
}

/** 0 = Sunday ... 6 = Saturday, for the label itself (no zone involved). */
export function dayOfWeek(day: DayKey): number {
  return keyToUtc(day).getUTCDay();
}

/** Whole days from `a` to `b` (negative when `b` is earlier). */
export function daysBetween(a: DayKey, b: DayKey): number {
  return Math.round((keyToUtc(b).getTime() - keyToUtc(a).getTime()) / DAY_MS);
}

export function startOfWeek(day: DayKey, weekStart: WeekStart): DayKey {
  return addDays(day, -((dayOfWeek(day) - weekStart + 7) % 7));
}

export function weekDays(day: DayKey, weekStart: WeekStart): DayKey[] {
  const first = startOfWeek(day, weekStart);
  return Array.from({ length: 7 }, (_, i) => addDays(first, i));
}

export function startOfMonth(day: DayKey): DayKey {
  return `${day.slice(0, 7)}-01`;
}

export function endOfMonth(day: DayKey): DayKey {
  const [y, m] = day.split('-').map(Number);
  return utcToKey(new Date(Date.UTC(y, m, 0)));
}

/** The same day-of-month `n` months on, clamped: 31 Jan + 1 month is 28/29 Feb, not 3 Mar. */
export function addMonths(day: DayKey, n: number): DayKey {
  const [y, m, d] = day.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return utcToKey(new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))));
}

/** The weeks a month view draws: whole weeks from the one holding the 1st to the one holding the last day. */
export function monthGrid(day: DayKey, weekStart: WeekStart): DayKey[][] {
  const first = startOfWeek(startOfMonth(day), weekStart);
  const last = endOfMonth(day);
  const weeks: DayKey[][] = [];
  for (let start = first; start <= last; start = addDays(start, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(start, i)));
  }
  return weeks;
}

/** The inclusive range of days a view shows around `anchor`. */
export function visibleRange(
  view: CalendarView,
  anchor: DayKey,
  weekStart: WeekStart,
): { from: DayKey; to: DayKey } {
  switch (view) {
    case 'month': {
      const weeks = monthGrid(anchor, weekStart);
      return { from: weeks[0][0], to: weeks[weeks.length - 1][6] };
    }
    case 'week': {
      const days = weekDays(anchor, weekStart);
      return { from: days[0], to: days[6] };
    }
    case 'day':
      return { from: anchor, to: anchor };
    case 'agenda':
      // The agenda lists the calendar month, so Previous and Next page by month on a phone too.
      return { from: startOfMonth(anchor), to: endOfMonth(anchor) };
  }
}

/** Where Previous (-1) or Next (+1) goes from `anchor` in `view`. */
export function stepAnchor(view: CalendarView, anchor: DayKey, direction: -1 | 1): DayKey {
  switch (view) {
    case 'month':
    case 'agenda':
      return addMonths(anchor, direction);
    case 'week':
      return addDays(anchor, 7 * direction);
    case 'day':
      return addDays(anchor, direction);
  }
}

/**
 * The first day of the week where the organizer is registered: Sunday in the US and Canada,
 * Monday everywhere else this product sells (India, the UK, the Gulf). An unknown country gets
 * Monday, the ISO week.
 */
export function weekStartFor(country: string | null | undefined): WeekStart {
  const code = marketFor(country)?.code;
  return code === 'US' || code === 'CA' ? 0 : 1;
}

/**
 * Which day a keyboard key moves focus to in the month grid, or null for a key it ignores.
 * Arrows move by a day or a week; Home and End go to the ends of the focused day's week.
 */
export function focusTarget(day: DayKey, key: string, weekStart: WeekStart): DayKey | null {
  switch (key) {
    case 'ArrowLeft':
      return addDays(day, -1);
    case 'ArrowRight':
      return addDays(day, 1);
    case 'ArrowUp':
      return addDays(day, -7);
    case 'ArrowDown':
      return addDays(day, 7);
    case 'Home':
      return startOfWeek(day, weekStart);
    case 'End':
      return addDays(startOfWeek(day, weekStart), 6);
    default:
      return null;
  }
}

// ─── Instants into venue-local days ───

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(zone: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    partsFormatters.set(zone, f);
  }
  return f;
}

/** An instant as the venue's calendar date and the minute of that date. */
export function localPlace(iso: string | Date, zone: string): { day: DayKey; minute: number } {
  const parts = partsFormatter(zone).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  const hour = Number(get('hour')) % 24;
  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    minute: hour * 60 + Number(get('minute')),
  };
}

/** "19:00", at the venue. 24-hour, the same as the cinema scheduler. */
export function formatClock(iso: string, zone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

/** "IST", "MDT" or "GMT+5:30": the zone's short name AT that instant, so DST shows. */
export function zoneAbbrev(zone: string, at: string | Date): string {
  return (
    new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' })
      .formatToParts(new Date(at))
      .find((p) => p.type === 'timeZoneName')?.value ?? zone
  );
}

/** "Fri, 6 Nov 2026" for a label. Formatted at UTC midday so the label is never shifted. */
export function formatDayLong(day: DayKey): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${day}T12:00:00Z`));
}

/** "Mon 21", for a week or day column heading. */
export function formatDayShort(day: DayKey): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
  }).format(new Date(`${day}T12:00:00Z`));
}

/** "November 2026", "2 - 8 Nov 2026" or "Fri, 6 Nov 2026": the toolbar's title. */
export function rangeTitle(view: CalendarView, anchor: DayKey, weekStart: WeekStart): string {
  if (view === 'day') return formatDayLong(anchor);
  if (view === 'week') {
    const days = weekDays(anchor, weekStart);
    const fmt = (d: DayKey, opts: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts }).format(
        new Date(`${d}T12:00:00Z`),
      );
    return `${fmt(days[0], { day: 'numeric', month: 'short' })} - ${fmt(days[6], {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    })}`;
  }
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${startOfMonth(anchor)}T12:00:00Z`));
}

// ─── From the API ───

/**
 * The zone a session is placed in, and whether it is really the venue's.
 *
 * A film show in a cinema was typed in the CINEMA's zone (the cinema scheduler converts in it),
 * so it is drawn in that zone. Everything else was typed in the venue's zone - its own, else the
 * only zone its country has - by the same `venueInputZone` the session form uses, so a show is
 * drawn at exactly the time it was entered. A venue in a multi-zone country with no zone set
 * falls back to the browser's, flagged `known: false` so the preview can say so.
 */
export function sessionZone(row: OrganizerCalendarSession): { zone: string; known: boolean } {
  if (row.event.experienceType === 'MOVIE' && row.cinemaTimezone) {
    return { zone: row.cinemaTimezone, known: true };
  }
  return venueInputZone(row.venue);
}

/** The API's sessions, resolved for the calendar. */
export function toCalendarSessions(rows: OrganizerCalendarSession[]): CalendarSession[] {
  return rows.map((r) => {
    const { zone, known } = sessionZone(r);
    return {
      id: r.id,
      eventId: r.event.id,
      title: r.event.title,
      category: r.event.category,
      eventStatus: r.event.status,
      sessionStatus: r.status,
      venueId: r.venue.id,
      venueName: r.venue.name,
      city: r.venue.city,
      zone,
      zoneKnown: known,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      sold: r.sold,
      capacity: r.capacity,
    };
  });
}

/**
 * The instants to ask the API for, so every session on the visible LOCAL days comes back.
 *
 * Venue zones run from UTC-12 to UTC+14, so a local day can begin up to 14 hours before its UTC
 * midnight and end up to 12 hours after the next. A day of padding each side covers every zone
 * with room to spare; sessions outside the visible days are then dropped by `segmentsByDay`.
 */
export function fetchWindow(range: { from: DayKey; to: DayKey }): { from: string; to: string } {
  return {
    from: `${addDays(range.from, -1)}T00:00:00.000Z`,
    to: `${addDays(range.to, 2)}T00:00:00.000Z`,
  };
}

export interface CalendarFilters {
  /** One EventStatus, or '' for all. */
  status: string;
  venueId: string;
  category: string;
}

export function filterSessions(
  sessions: CalendarSession[],
  filters: CalendarFilters,
): CalendarSession[] {
  return sessions.filter(
    (s) =>
      (!filters.status || s.eventStatus === filters.status) &&
      (!filters.venueId || s.venueId === filters.venueId) &&
      (!filters.category || s.category === filters.category),
  );
}

/**
 * The venue and category menus: every venue the organization has and every category its
 * events use - not only those in the visible window, or a chosen venue would vanish from its
 * own menu the moment the organizer paged to a month where it has nothing on.
 */
export function filterOptions(
  venues: { id: string; name: string; city: string }[],
  events: { category: string }[],
): {
  venues: { id: string; label: string }[];
  categories: string[];
} {
  return {
    venues: venues
      .map((v) => ({ id: v.id, label: v.city ? `${v.name}, ${v.city}` : v.name }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    categories: [...new Set(events.map((e) => e.category).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b),
    ),
  };
}

/**
 * Each session cut into one segment per venue-local day it touches, for the days in
 * `[from, to]`, each day's segments in start order.
 *
 * A session ending exactly at midnight does not touch the next day - a 20:00-00:00 show is a
 * one-day show. A session whose end is not after its start (bad data) is kept as a point
 * rather than dropped: the calendar must never hide a session.
 */
export function segmentsByDay(
  sessions: CalendarSession[],
  from: DayKey,
  to: DayKey,
): Map<DayKey, DaySegment[]> {
  const byDay = new Map<DayKey, DaySegment[]>();
  for (let d = from; d <= to; d = addDays(d, 1)) byDay.set(d, []);

  for (const session of sessions) {
    const start = localPlace(session.startsAt, session.zone);
    let end = localPlace(session.endsAt, session.zone);
    if (new Date(session.endsAt).getTime() <= new Date(session.startsAt).getTime()) end = start;
    let lastDay = end.day;
    let lastEndMin = end.minute;
    if (end.minute === 0 && end.day > start.day) {
      lastDay = addDays(end.day, -1);
      lastEndMin = MINUTES_IN_DAY;
    }
    if (lastDay < from || start.day > to) continue;
    const first = start.day < from ? from : start.day;
    const last = lastDay > to ? to : lastDay;
    for (let d = first; d <= last; d = addDays(d, 1)) {
      byDay.get(d)?.push({
        session,
        day: d,
        startMin: d === start.day ? start.minute : 0,
        endMin: d === lastDay ? lastEndMin : MINUTES_IN_DAY,
        continuesBefore: d !== start.day,
        continuesAfter: d !== lastDay,
      });
    }
  }

  for (const list of byDay.values()) {
    list.sort(
      (a, b) =>
        a.startMin - b.startMin ||
        b.endMin - a.endMin ||
        a.session.title.localeCompare(b.session.title) ||
        a.session.id.localeCompare(b.session.id),
    );
  }
  return byDay;
}

/** A segment's place in a time grid: which column of how many. */
export interface PlacedSegment {
  segment: DaySegment;
  column: number;
  columns: number;
}

/**
 * Side-by-side columns for overlapping segments in one day, so none is drawn on top of another.
 *
 * Segments that overlap, directly or through a chain, form a cluster; each takes the first
 * column free at its start, and every member of a cluster is drawn the cluster's width. A
 * segment shorter than `minMinutes` is laid out as if it were that long, because that is the
 * height it is drawn at - two 5-minute slots 10 minutes apart would otherwise overlap on screen
 * while counting as separate.
 */
export function layoutDay(segments: DaySegment[], minMinutes = 30): PlacedSegment[] {
  const sorted = [...segments].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  const placed: PlacedSegment[] = [];
  let cluster: PlacedSegment[] = [];
  let columnEnds: number[] = [];
  let clusterEnd = -1;

  const close = () => {
    for (const p of cluster) p.columns = columnEnds.length;
    cluster = [];
    columnEnds = [];
  };

  for (const segment of sorted) {
    const end = Math.max(segment.endMin, segment.startMin + minMinutes);
    if (segment.startMin >= clusterEnd) close();
    let column = columnEnds.findIndex((e) => e <= segment.startMin);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(end);
    } else {
      columnEnds[column] = end;
    }
    const p = { segment, column, columns: 1 };
    cluster.push(p);
    placed.push(p);
    clusterEnd = Math.max(clusterEnd, end);
  }
  close();
  return placed;
}

/** The first `max` items and how many more there are, for a "+N more" link. */
export function capItems<T>(items: T[], max: number): { shown: T[]; hidden: number } {
  if (items.length <= max) return { shown: items, hidden: 0 };
  return { shown: items.slice(0, max), hidden: items.length - max };
}

/** Phones get the agenda: a month grid at 320px is seven unreadable slivers. */
export function defaultViewFor(width: number): CalendarView {
  return width < 768 ? 'agenda' : 'month';
}

/** Owners and managers create events; check-in staff cannot. Null role = platform admin. */
export function canCreateEvents(role: string | null | undefined): boolean {
  return role == null || role === 'ORGANIZER_OWNER' || role === 'ORGANIZER_MANAGER';
}

/**
 * A day's segments split into those drawn in the time grid and those drawn in the strip above
 * it. A session that runs across midnight into another day goes in the strip: drawn in the grid
 * it is a column-high block that hides every timed session beside it and shows no title.
 */
export function splitSpanning(segments: DaySegment[]): {
  timed: DaySegment[];
  spanning: DaySegment[];
} {
  const timed: DaySegment[] = [];
  const spanning: DaySegment[] = [];
  for (const s of segments) (s.continuesBefore || s.continuesAfter ? spanning : timed).push(s);
  return { timed, spanning };
}
