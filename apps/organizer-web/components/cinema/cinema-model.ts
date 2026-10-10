import type { Movie, ShowRow } from '@eticketsgo/web-kit';
import {
  foldSaleStates,
  type EventSaleState,
  type SaleStateKind,
  type SessionSaleState,
} from '@eticketsgo/shared-types';
import { CHECKING_LABEL, saleViewOf } from '../../lib/sale-state';

/**
 * The rules the cinema workspace draws with: films, their showtimes, and whether they sell.
 *
 * Pure functions, so every sentence the Movies pages say about money and sale state can be
 * tested without a browser. None of it DECIDES anything. Whether a show can be bought is the
 * server's answer (`saleEligibility`, the function checkout refuses a sale with); this file
 * only puts that answer into words, and never says "Selling" without it.
 */

export type Tone = 'success' | 'warning' | 'error' | 'info' | 'neutral';

// ── Films ─────────────────────────────────────────────────────────────────────────

/** "2h 18m" - how a cinema lists a running time. */
export function formatRuntime(minutes: number | null | undefined): string | null {
  if (!minutes || !Number.isFinite(minutes) || minutes <= 0) return null;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** The film's lifecycle in the console's words. The enum is never shown raw. */
export function filmStatusLabel(status: string): { label: string; tone: Tone } {
  switch (status) {
    case 'PUBLISHED':
      return { label: 'Published', tone: 'success' };
    case 'ARCHIVED':
      return { label: 'Archived', tone: 'neutral' };
    case 'DRAFT':
      return { label: 'Draft', tone: 'neutral' };
    default:
      return { label: status, tone: 'neutral' };
  }
}

export interface FilmFilter {
  q: string;
  status: string;
  language: string;
}

/** Search matches the title, the cast and the director: what an operator remembers a film by. */
export function filterFilms(movies: Movie[], f: FilmFilter): Movie[] {
  const q = f.q.trim().toLowerCase();
  return movies.filter((m) => {
    if (f.status && m.status !== f.status) return false;
    if (f.language && m.language !== f.language) return false;
    if (!q) return true;
    return [m.title, m.director ?? '', ...(m.cast ?? []), ...(m.genres ?? [])].some((s) =>
      s.toLowerCase().includes(q),
    );
  });
}

/** The languages present in the library, for the language filter. Never a fixed list. */
export const languagesOf = (movies: Movie[]): string[] =>
  [...new Set(movies.map((m) => m.language).filter(Boolean))].sort((a, b) => a.localeCompare(b));

// ── Showtimes ─────────────────────────────────────────────────────────────────────

/** A show that has not started and has not been cancelled - one an operator still plans for. */
export const isUpcoming = (s: ShowRow, now: Date): boolean =>
  s.status !== 'CANCELLED' && s.status !== 'COMPLETED' && new Date(s.startsAt) > now;

export interface FilmProgramme {
  upcoming: number;
  /** Cinemas the film plays at from now on, by name, most shows first. */
  cinemas: { id: string; name: string; shows: number }[];
  next: ShowRow | null;
  /** Seats sold and on sale across the upcoming shows. */
  sold: number;
  total: number;
}

/** Where and how often a film plays from now on. */
export function programmeOf(rows: ShowRow[] | undefined, now: Date): FilmProgramme {
  const upcoming = (rows ?? [])
    .filter((s) => isUpcoming(s, now))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const byCinema = new Map<string, { id: string; name: string; shows: number }>();
  let sold = 0;
  let total = 0;
  for (const s of upcoming) {
    const id = s.cinemaId ?? 'unknown';
    const seen = byCinema.get(id);
    if (seen) seen.shows += 1;
    else byCinema.set(id, { id, name: s.cinemaName ?? 'Unknown cinema', shows: 1 });
    sold += s.seatsSold;
    total += s.seatsTotal;
  }
  return {
    upcoming: upcoming.length,
    cinemas: [...byCinema.values()].sort(
      (a, b) => b.shows - a.shows || a.name.localeCompare(b.name),
    ),
    next: upcoming[0] ?? null,
    sold,
    total,
  };
}

/** "Sat 10 Oct, 14:48" at the cinema. 24-hour, as a theatre publishes it. */
export function formatShowTime(iso: string, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

/** "14:48" at the cinema. */
export function formatClock(iso: string, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

/**
 * "IST", "MDT": the short name of a cinema's zone, as its own audience writes it.
 *
 * `en-US` names American zones and leaves the rest as "GMT+5:30", which no Indian cinema
 * prints; the zone's own English locale is tried for those.
 */
export function zoneShort(iso: string | Date, timeZone: string | undefined): string {
  if (!timeZone) return '';
  const name = (locale: string) =>
    new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'short' })
      .formatToParts(new Date(iso))
      .find((p) => p.type === 'timeZoneName')?.value ?? '';
  try {
    const us = name('en-US');
    if (!us.startsWith('GMT')) return us;
    const local = name(
      timeZone === 'Asia/Kolkata' || timeZone === 'Asia/Calcutta' ? 'en-IN' : 'en-GB',
    );
    return local || us;
  } catch {
    return timeZone;
  }
}

/** The calendar date of an instant AT THE CINEMA, YYYY-MM-DD. */
export const localDate = (iso: string | Date, timeZone: string | undefined): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(iso));

/** "Mon 12 Oct" for a local date label; the year only when it is not this year. */
export function dateLabel(date: string, today: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: date.slice(0, 4) === today.slice(0, 4) ? undefined : 'numeric',
  }).format(new Date(`${date}T12:00:00Z`));
}

/** "Today", "Tomorrow" or "Mon 12 Oct", for a local date label. */
export function dayHeading(date: string, today: string): string {
  if (date === today) return 'Today';
  const t = new Date(`${today}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  if (date === t.toISOString().slice(0, 10)) return 'Tomorrow';
  return dateLabel(date, today);
}

/**
 * Shows grouped by the day they play, each on ITS cinema's calendar.
 *
 * A film at a Hyderabad and a Boise cinema has shows on two clocks. A 23:30 Boise show is
 * "tomorrow" in Hyderabad; grouping it by the reader's clock would put it under a day the
 * cinema does not call it. Each show is dated in its own zone, and the day headings are the
 * cinemas' own dates.
 */
export function groupByDay(
  rows: ShowRow[],
  zoneOf: (cinemaId: string | null) => string | undefined,
): { date: string; shows: ShowRow[] }[] {
  const days = new Map<string, ShowRow[]>();
  for (const s of [...rows].sort((a, b) => a.startsAt.localeCompare(b.startsAt))) {
    const d = localDate(s.startsAt, zoneOf(s.cinemaId));
    const list = days.get(d);
    if (list) list.push(s);
    else days.set(d, [s]);
  }
  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, shows]) => ({ date, shows }));
}

/** Occupancy as a whole percent, or null with nothing to fill. Never above 100 on the bar. */
export const percentSold = (sold: number, total: number): number | null =>
  total > 0 ? Math.round((sold / total) * 100) : null;

// ── Today and this week at a cinema ───────────────────────────────────────────────

export interface CinemaGlance {
  cinemaId: string;
  cinemaName: string;
  timeZone: string | undefined;
  today: { shows: number; sold: number; total: number };
  week: { shows: number; sold: number; total: number };
  /** The next show still to start today, if any. */
  nextToday: ShowRow | null;
}

/**
 * Today and the next seven days for each cinema, from the shows already loaded.
 *
 * "Today" is the CINEMA's today. Shows that are cancelled are left out - they are not on the
 * programme. A show that already played today still counts towards today's seats, because a
 * manager asking "how did today go" means the whole day.
 */
export function glanceByCinema(
  rows: ShowRow[],
  zoneOf: (cinemaId: string | null) => string | undefined,
  now: Date,
): CinemaGlance[] {
  const out = new Map<string, CinemaGlance>();
  for (const s of rows) {
    if (!s.cinemaId || s.status === 'CANCELLED') continue;
    const zone = zoneOf(s.cinemaId);
    const today = localDate(now, zone);
    const weekEnd = new Date(`${today}T12:00:00Z`);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
    const lastDay = weekEnd.toISOString().slice(0, 10);
    const day = localDate(s.startsAt, zone);
    if (day < today || day > lastDay) continue;
    let g = out.get(s.cinemaId);
    if (!g) {
      g = {
        cinemaId: s.cinemaId,
        cinemaName: s.cinemaName ?? 'Unknown cinema',
        timeZone: zone,
        today: { shows: 0, sold: 0, total: 0 },
        week: { shows: 0, sold: 0, total: 0 },
        nextToday: null,
      };
      out.set(s.cinemaId, g);
    }
    g.week.shows += 1;
    g.week.sold += s.seatsSold;
    g.week.total += s.seatsTotal;
    if (day === today) {
      g.today.shows += 1;
      g.today.sold += s.seatsSold;
      g.today.total += s.seatsTotal;
      if (new Date(s.startsAt) > now && (!g.nextToday || s.startsAt < g.nextToday.startsAt))
        g.nextToday = s;
    }
  }
  return [...out.values()].sort(
    (a, b) =>
      b.today.shows - a.today.shows ||
      b.week.shows - a.week.shows ||
      a.cinemaName.localeCompare(b.cinemaName),
  );
}

// ── Can it be bought? ─────────────────────────────────────────────────────────────

/*
  Every sentence below is the server's unified sale state (`sale-state.ts` in shared-types),
  put into words - per show from `GET /organizer-calendar/sale-eligibility`, per cinema listing
  (one event per film per venue) from `.../event-sale-eligibility`. The library card, the film
  header, the cinema strip, the showtimes and the quick look therefore cannot disagree with
  each other, or with the Overview and the event pages, about one show.

  This used to read the cinema readiness report (pricing rules only) and the public summary's
  `onlineBooking.open`, and work the rest out here. On QA a film read "Selling" while one of
  its shows refused Standard seats, and the Overview said "Not selling" about the same show.
*/

/** An answer that may still be loading (undefined) or could not be read (null). */
export type MaybeSale = Pick<EventSaleState, 'state' | 'reasons'> | null | undefined;

export interface SaleVerdict {
  /** The server's unified state; null while unanswered or unreadable. */
  state?: SaleStateKind | null;
  /** True only when the server has said SELLING. Never for a partly selling show. */
  selling: boolean;
  /** "Selling", "Partly selling: <reason>", "Not selling: <reason>", or "Checking sale status". */
  label: string;
  tone: Tone;
  /** The longer explanation, when there is one. */
  detail: string | null;
  /** Where the organizer fixes it, relative to the console. */
  fixPath: string | null;
}

/** A cinema's verdict in the chip's words. */
export interface ShowSaleInput {
  show: ShowRow;
  timeZone: string | undefined;
  /**
   * The server's unified answer for this show (`GET /organizer-calendar/sale-eligibility`):
   * the event and show status, the film, each ticket type's window and places, and checkout's
   * sale-eligibility rule. `undefined` while loading; `null` when it could not be read.
   */
  sale: Pick<SessionSaleState, 'state' | 'reasons'> | null | undefined;
}

/**
 * One answer to "can somebody buy this show right now, and if not, why" - the server's.
 *
 * This used to work the answer out here from the show's status, its booking window, the film
 * and the public `onlineBooking.open`, and called a show "Selling" (with "Some seat categories
 * cannot be sold" underneath) when checkout refused its Standard seats and sold its Gold ones.
 * The Overview called the same show "Not selling". Both now read one server answer, and a
 * partly selling show says so: "Partly selling: seat classes not mapped".
 */
export function showSaleVerdict(i: ShowSaleInput): SaleVerdict {
  if (i.sale === undefined)
    return {
      state: null,
      selling: false,
      label: CHECKING_LABEL,
      tone: 'neutral',
      detail: null,
      fixPath: null,
    };
  if (i.sale === null)
    // The server's answer could not be read. Say that, rather than guess either way.
    return {
      state: null,
      selling: false,
      label: 'Sale status unavailable',
      tone: 'neutral',
      detail: 'We could not confirm whether this show can be bought. Refresh to try again.',
      fixPath: null,
    };
  const view = saleViewOf(i.sale);
  const lead = i.sale.reasons[0];
  /*
    One refinement of the server's words, never of its decision: a booking window that has not
    opened is more use with its date, on the cinema's clock.
  */
  const label =
    i.sale.state === 'NOT_SELLING' && lead?.code === 'SALES_NOT_STARTED' && i.show.salesStartAt
      ? `Not selling: bookings open ${formatShowTime(i.show.salesStartAt, i.timeZone)}`
      : view.label;
  return {
    state: view.state,
    selling: view.selling,
    label,
    tone: view.tone,
    detail: view.detail,
    fixPath: view.fixPath,
  };
}

const notSelling = (
  reason: string,
  detail: string | null,
  tone: Tone = 'neutral',
  fixPath: string | null = null,
): SaleVerdict => ({
  state: 'NOT_SELLING',
  selling: false,
  label: `Not selling: ${reason}`,
  tone,
  detail,
  fixPath,
});

export type FilmSale = SaleVerdict & {
  /** Cinemas where nothing upcoming can be bought, with the reason. */
  exceptions: { cinema: string; reason: string }[];
  /** Some upcoming shows sell and some do not. Never labelled plain "Selling". */
  partial: boolean;
};

const unconfirmed = (loading: boolean): SaleVerdict => ({
  state: null,
  selling: false,
  label: loading ? CHECKING_LABEL : 'Sale status not confirmed',
  tone: 'neutral',
  detail: null,
  fixPath: null,
});

/**
 * The server's answers for the cinema listings these upcoming shows belong to, folded into one.
 * `undefined` while any is loading; `null` when any could not be read (or the API sent no
 * listing id) - never a hopeful guess either way.
 */
function foldListings(
  shows: ShowRow[],
  listing: (eventId: string) => MaybeSale,
): ReturnType<typeof foldSaleStates> | null | undefined {
  const ids = [...new Set(shows.map((s) => s.eventId ?? ''))];
  const answers = ids.map((id) => (id ? listing(id) : null));
  if (answers.some((a) => a === null)) return null;
  if (answers.some((a) => a === undefined)) return undefined;
  return foldSaleStates(answers as Pick<EventSaleState, 'state' | 'reasons'>[]);
}

/**
 * A film's sale state across its cinemas, for the library card and the film header.
 *
 * The server's answer for each cinema listing the film's upcoming shows belong to, folded the
 * way shows fold into an event: all SELLING -> "Selling"; nothing open -> "Not selling:
 * <reason>"; otherwise "Partly selling: <reason>" - and where the clearest reason is that it
 * sells at some cinemas and not others, the count is the reason ("at 1 of 2 cinemas").
 */
export function filmSaleSummary(
  film: Pick<Movie, 'status'>,
  programme: FilmProgramme,
  rows: ShowRow[] | undefined,
  now: Date,
  listing: (eventId: string) => MaybeSale,
): FilmSale {
  const none = { exceptions: [] as { cinema: string; reason: string }[], partial: false };
  if (film.status !== 'PUBLISHED') return { ...notSelling('film not published', null), ...none };
  if (programme.upcoming === 0) return { ...notSelling('no upcoming shows', null), ...none };

  const upcoming = (rows ?? []).filter((s) => isUpcoming(s, now));
  const folded = foldListings(upcoming, listing);
  if (folded === undefined) return { ...unconfirmed(true), ...none };
  if (folded === null) return { ...unconfirmed(false), ...none };

  // Per cinema, for the exceptions and the "at 1 of 2 cinemas" count.
  const cinemas = programme.cinemas.map((c) => {
    const here = foldListings(
      upcoming.filter((s) => (s.cinemaId ?? 'unknown') === c.id),
      listing,
    );
    return { name: c.name, sale: here ?? null };
  });
  const exceptions = cinemas
    .filter((c) => c.sale?.state === 'NOT_SELLING')
    .map((c) => ({
      cinema: c.name,
      reason: c.sale!.reasons[0]?.text ?? 'checkout would refuse it',
    }));

  const view = saleViewOf(folded);
  if (folded.state !== 'PARTIAL') return { ...view, exceptions, partial: false };
  const openCinemas = cinemas.filter((c) => c.sale && c.sale.state !== 'NOT_SELLING').length;
  const label =
    openCinemas < cinemas.length
      ? `Partly selling: at ${openCinemas} of ${cinemas.length} ${cinemas.length === 1 ? 'cinema' : 'cinemas'}`
      : view.label;
  return { ...view, label, exceptions, partial: true };
}

/**
 * One cinema's state over the upcoming shows loaded for it, for the "this week at your
 * cinemas" strip. The same fold as the film, scoped to one place.
 */
export function cinemaSaleVerdict(
  cinemaId: string,
  rows: ShowRow[],
  now: Date,
  listing: (eventId: string) => MaybeSale,
): SaleVerdict {
  const upcoming = rows.filter((s) => s.cinemaId === cinemaId && isUpcoming(s, now));
  if (upcoming.length === 0) return notSelling('no upcoming shows', null);
  const folded = foldListings(upcoming, listing);
  if (folded === undefined) return unconfirmed(true);
  if (folded === null) return unconfirmed(false);
  return saleViewOf(folded);
}
