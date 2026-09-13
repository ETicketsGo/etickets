/**
 * The film page's showtime picker, as pure functions.
 *
 * Framework-free on purpose: the storefront renders it today, and the mobile app lists the same
 * screenings. Every rule a customer can see — which days the strip offers, which day opens
 * first, what counts as "evening", which cinema is listed first — lives here once and is tested
 * here, rather than being re-derived inside a component where it cannot be.
 *
 * ── TIME ZONES ─────────────────────────────────────────────────────────────────────
 * Everything is in the CINEMA's zone. A 00:30 show in Hyderabad is a Saturday show in
 * Hyderabad, whoever is looking. Days come from the server's `localDate`; clock times come from
 * `Intl` with the cinema's `timezone`. Only a row with no cinema falls back to the browser zone,
 * because then there is nothing better to use.
 */
import type { PublicShowRow, ShowAvailability } from './api';

/** A coarse part of the day, in the cinema's local time. */
export type TimeOfDay = 'MORNING' | 'AFTERNOON' | 'EVENING' | 'NIGHT';

/** In the order they happen, which is the order the filter chips are shown in. */
export const TIMES_OF_DAY: readonly TimeOfDay[] = ['MORNING', 'AFTERNOON', 'EVENING', 'NIGHT'];

/** What the customer has narrowed the list to. An empty group restricts nothing. */
export interface ShowtimeFilters {
  formats: readonly string[];
  times: readonly TimeOfDay[];
}

export const NO_SHOWTIME_FILTERS: ShowtimeFilters = { formats: [], times: [] };

/** One tile of the date strip. */
export interface StripDay {
  /** Cinema-local calendar date, YYYY-MM-DD. */
  date: string;
  /** Every screening that day, bookable or not. Zero means the tile is disabled. */
  shows: number;
  /** Screenings that day that can still be bought. */
  bookable: number;
}

/** The screenings at one cinema, as a card lists them. */
export interface CinemaShowtimes {
  /** Stable across visits — what a favourite is stored under. */
  key: string;
  name: string;
  brand: string | null;
  city: string;
  /** The zone its times are shown in; undefined when the row had no cinema. */
  timeZone: string | undefined;
  favourite: boolean;
  /** In start order. */
  shows: PublicShowRow[];
}

export const DATE_STRIP_DAYS = 7;

// ── Clock ────────────────────────────────────────────────────────────────────────

const zoneValidity = new Map<string, boolean>();

/**
 * The zone if `Intl` accepts it, else undefined (the browser's zone).
 *
 * A cinema's zone is typed in by an organizer. A misspelt one must cost the customer the
 * correct offset, not the whole page: `Intl` throws a RangeError on an unknown zone.
 */
export function safeTimeZone(timeZone: string | null | undefined): string | undefined {
  if (!timeZone) return undefined;
  let valid = zoneValidity.get(timeZone);
  if (valid === undefined) {
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone });
      valid = true;
    } catch {
      valid = false;
    }
    zoneValidity.set(timeZone, valid);
  }
  return valid ? timeZone : undefined;
}

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

function clockFormatter(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? '';
  let formatter = clockFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      ...(timeZone ? { timeZone } : {}),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    clockFormatters.set(key, formatter);
  }
  return formatter;
}

/** The wall clock at an instant, in a zone: its calendar date, hour (0–23) and minute. */
export function localClock(
  instant: string | Date,
  timeZone?: string | null,
): { date: string; hour: number; minute: number } {
  const parts = clockFormatter(safeTimeZone(timeZone)).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '00';
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    // Some engines print midnight as "24" even with h23; it is hour 0 of the same date.
    hour: Number(part('hour')) % 24,
    minute: Number(part('minute')),
  };
}

/** The zone a show's times are displayed in: its cinema's, when it has a valid one. */
export function showTimeZone(show: Pick<PublicShowRow, 'cinema'>): string | undefined {
  return safeTimeZone(show.cinema?.timezone);
}

/**
 * The cinema-local day a show belongs to.
 *
 * The server's `localDate` when present. Never the ISO string sliced: that is the UTC date,
 * which files a 00:30 IST show under the day before.
 */
export function showLocalDate(
  show: Pick<PublicShowRow, 'localDate' | 'startsAt' | 'cinema'>,
): string {
  return show.localDate ?? localClock(show.startsAt, showTimeZone(show)).date;
}

/** Morning before 12:00, afternoon 12:00–15:59, evening 16:00–18:59, night from 19:00. */
export function timeOfDay(instant: string | Date, timeZone?: string | null): TimeOfDay {
  const { hour } = localClock(instant, timeZone);
  if (hour < 12) return 'MORNING';
  if (hour < 16) return 'AFTERNOON';
  if (hour < 19) return 'EVENING';
  return 'NIGHT';
}

/**
 * Starts at 23:00 or later, or before 05:00.
 *
 * Worth marking because "Morning" alone would file a 01:00 show beside a 10:00 one, and someone
 * booking the night of the 13th needs to see that 01:00 on the 14th is really that night.
 */
export function isLateNight(instant: string | Date, timeZone?: string | null): boolean {
  const { hour } = localClock(instant, timeZone);
  return hour >= 23 || hour < 5;
}

/** Whether a customer can still buy a ticket. Paused sales are listed but not sold. */
export function isBookable(availability: ShowAvailability): boolean {
  return availability === 'AVAILABLE' || availability === 'LIMITED';
}

// ── Days ─────────────────────────────────────────────────────────────────────────

/**
 * A calendar date moved by whole days.
 *
 * Arithmetic on the DATE, done at UTC midnight where no zone has a daylight-saving gap, so
 * slicing the result is exact. This is not an instant and is never shown as one.
 */
export function addCalendarDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Every day with at least one screening, ascending. */
export function showDates(shows: readonly PublicShowRow[]): string[] {
  return [...new Set(shows.map(showLocalDate))].sort();
}

function dayCounts(
  shows: readonly PublicShowRow[],
): Map<string, { shows: number; bookable: number }> {
  const counts = new Map<string, { shows: number; bookable: number }>();
  for (const show of shows) {
    const date = showLocalDate(show);
    const entry = counts.get(date) ?? { shows: 0, bookable: 0 };
    entry.shows += 1;
    if (isBookable(show.availability)) entry.bookable += 1;
    counts.set(date, entry);
  }
  return counts;
}

/**
 * The start of each page of the date strip.
 *
 * The first page starts on the first day with a show; each later page starts on the first show
 * day at least `size` days after the previous start. So every show day is on exactly one page,
 * and a film whose next run is five months away pages straight to it instead of through twenty
 * weeks of greyed-out tiles.
 */
export function dateWindows(shows: readonly PublicShowRow[], size = DATE_STRIP_DAYS): string[] {
  const starts: string[] = [];
  for (const date of showDates(shows)) {
    const last = starts[starts.length - 1];
    if (last === undefined || date >= addCalendarDays(last, size)) starts.push(date);
  }
  return starts;
}

/** The page of the strip a date is on, or null when no page holds it. */
export function windowFor(
  shows: readonly PublicShowRow[],
  date: string,
  size = DATE_STRIP_DAYS,
): string | null {
  const start = dateWindows(shows, size)
    .filter((s) => s <= date)
    .pop();
  return start !== undefined && date < addCalendarDays(start, size) ? start : null;
}

/**
 * `size` consecutive days from `start` (default: the first day with a show), each with its
 * counts. Days with nothing on are kept, so the strip reads as a calendar rather than a list
 * with holes the customer has to notice.
 */
export function buildDateStrip(
  shows: readonly PublicShowRow[],
  options: { start?: string; size?: number } = {},
): StripDay[] {
  const size = options.size ?? DATE_STRIP_DAYS;
  const start = options.start ?? showDates(shows)[0];
  if (!start) return [];
  const counts = dayCounts(shows);
  return Array.from({ length: size }, (_, i) => {
    const date = addCalendarDays(start, i);
    return { date, shows: 0, bookable: 0, ...counts.get(date) };
  });
}

/** The first day that can be booked, else the first day with anything on, else null. */
export function preferredDay(days: readonly StripDay[]): string | null {
  return (days.find((d) => d.bookable > 0) ?? days.find((d) => d.shows > 0))?.date ?? null;
}

/**
 * The day the page opens on.
 *
 * The first day with a BOOKABLE show, not merely the first day with a show: opening on a day
 * that is entirely sold out shows a customer a wall of greyed pills and makes the film look
 * unavailable when tomorrow is wide open.
 */
export function defaultShowDate(shows: readonly PublicShowRow[]): string | null {
  const counts = dayCounts(shows);
  return preferredDay(
    showDates(shows).map((date) => ({ date, ...(counts.get(date) ?? { shows: 0, bookable: 0 }) })),
  );
}

/** The day to show: the one picked, while it still has shows; otherwise the default. */
export function resolveShowDate(
  shows: readonly PublicShowRow[],
  picked: string | null | undefined,
): string | null {
  if (picked && shows.some((s) => showLocalDate(s) === picked)) return picked;
  return defaultShowDate(shows);
}

/** The screenings on one cinema-local day. */
export function rowsOnDate(shows: readonly PublicShowRow[], date: string | null): PublicShowRow[] {
  return date ? shows.filter((s) => showLocalDate(s) === date) : [];
}

// ── Filters ──────────────────────────────────────────────────────────────────────

export function hasActiveShowtimeFilters(filters: ShowtimeFilters): boolean {
  return filters.formats.length > 0 || filters.times.length > 0;
}

/**
 * Any of the chosen formats AND any of the chosen times.
 *
 * OR within a group, because nobody wants a show that is both IMAX and 3D; AND across groups,
 * because "IMAX in the evening" means both. A show with no format never matches a format filter.
 */
export function matchesShowtimeFilters(show: PublicShowRow, filters: ShowtimeFilters): boolean {
  if (filters.formats.length > 0 && !(show.format && filters.formats.includes(show.format))) {
    return false;
  }
  if (
    filters.times.length > 0 &&
    !filters.times.includes(timeOfDay(show.startsAt, showTimeZone(show)))
  ) {
    return false;
  }
  return true;
}

export function applyShowtimeFilters(
  shows: readonly PublicShowRow[],
  filters: ShowtimeFilters,
): PublicShowRow[] {
  return hasActiveShowtimeFilters(filters)
    ? shows.filter((s) => matchesShowtimeFilters(s, filters))
    : [...shows];
}

/** How many screenings fall in each part of the day — a zero disables that chip. */
export function countByTimeOfDay(shows: readonly PublicShowRow[]): Record<TimeOfDay, number> {
  const counts: Record<TimeOfDay, number> = { MORNING: 0, AFTERNOON: 0, EVENING: 0, NIGHT: 0 };
  for (const show of shows) counts[timeOfDay(show.startsAt, showTimeZone(show))] += 1;
  return counts;
}

// ── Cinemas ──────────────────────────────────────────────────────────────────────

/** A cinema's identity, or its venue's when the row has no cinema. */
export function cinemaKey(show: Pick<PublicShowRow, 'cinema' | 'venue'>): string {
  return show.cinema ? `cinema:${show.cinema.id}` : `venue:${show.venue.id}`;
}

const byName = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/**
 * The screenings grouped by cinema, optionally for one day.
 *
 * Favourites first, then by name, then by key — a fixed order, so a cinema does not change
 * place between two visits because the API happened to return its first show later. Shows run
 * in start order, and a tie breaks on the session id so the same list always renders the same.
 */
export function groupShowtimesByCinema(
  shows: readonly PublicShowRow[],
  options: { date?: string | null; favourites?: Iterable<string> } = {},
): CinemaShowtimes[] {
  const favourites = new Set(options.favourites ?? []);
  const groups = new Map<string, CinemaShowtimes>();

  for (const show of shows) {
    if (options.date && showLocalDate(show) !== options.date) continue;
    const key = cinemaKey(show);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        name: show.cinema?.name ?? show.venue.name,
        brand: show.cinema?.brand ?? null,
        city: show.venue.city,
        timeZone: showTimeZone(show),
        favourite: favourites.has(key),
        shows: [],
      };
      groups.set(key, group);
    }
    group.shows.push(show);
  }

  const list = [...groups.values()];
  for (const group of list) {
    group.shows.sort(
      (a, b) =>
        Date.parse(a.startsAt) - Date.parse(b.startsAt) ||
        (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0),
    );
  }
  return list.sort(
    (a, b) =>
      Number(b.favourite) - Number(a.favourite) ||
      byName.compare(a.name, b.name) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

// ── Labels ───────────────────────────────────────────────────────────────────────

const labelFormatters = new Map<string, Intl.DateTimeFormat>();

function cachedFormatter(key: string, make: () => Intl.DateTimeFormat): Intl.DateTimeFormat {
  let formatter = labelFormatters.get(key);
  if (!formatter) {
    formatter = make();
    labelFormatters.set(key, formatter);
  }
  return formatter;
}

/**
 * A show's start time as a customer reads it, in the cinema's zone.
 *
 * `locale` is `formatFor(uiLocale).locale`: undefined for English, which keeps the storefront's
 * en-IN 12-hour clock ("6:30 pm"); French gets its own 24-hour clock ("18 h 30").
 */
export function showtimeLabel(
  instant: string | Date,
  options: { timeZone?: string | null; locale?: string } = {},
): string {
  const timeZone = safeTimeZone(options.timeZone);
  const locale = options.locale;
  const formatter = cachedFormatter(
    `time|${locale ?? ''}|${timeZone ?? ''}`,
    () =>
      new Intl.DateTimeFormat(locale ?? 'en-IN', {
        hour: 'numeric',
        minute: '2-digit',
        ...(locale ? {} : { hour12: true }),
        ...(timeZone ? { timeZone } : {}),
      }),
  );
  return formatter.format(new Date(instant));
}

/**
 * The words on a date tile — "Sun" / "13" / "Sep" — and the full date for its accessible name.
 *
 * Formatted in UTC from the calendar date itself: the date is already the cinema's, and
 * formatting it in any real zone could move it a day.
 */
export function dayLabelParts(
  date: string,
  locale?: string,
): { weekday: string; day: string; month: string; full: string } {
  const [y, m, d] = date.split('-').map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d, 12));
  const tag = locale ?? 'en-IN';
  const format = (name: string, opts: Intl.DateTimeFormatOptions) =>
    cachedFormatter(
      `day|${tag}|${name}`,
      () => new Intl.DateTimeFormat(tag, { ...opts, timeZone: 'UTC' }),
    ).format(noon);
  return {
    weekday: format('weekday', { weekday: 'short' }),
    day: format('day', { day: 'numeric' }),
    month: format('month', { month: 'short' }),
    full: format('full', { weekday: 'long', day: 'numeric', month: 'long' }),
  };
}
