import type { Movie, PilotReadinessReport, ShowRow } from '@eticketsgo/web-kit';
import { bookingWindowState } from '../../app/organizer/cinemas/[id]/schedule/show-status';

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

/**
 * A short reason for a refusal checkout would make, by the server's blocker code.
 *
 * The server's own sentence (`organizerMessage`) is the long form and is always shown beside
 * this where there is room. This is the few words that fit on a chip: "Not selling: Telangana
 * pricing rules not configured".
 */
export function shortSaleReason(code: string, region: string | null | undefined): string {
  const place = region?.trim() ? region.trim() : 'state';
  switch (code.replace(/^SALE_/, '')) {
    case 'NO_PRICING_POLICY':
      return `${place} pricing rules not configured`;
    case 'PRICING_POLICY_CONFLICT':
      return `${place} pricing rules need correcting`;
    case 'CINEMA_NOT_CLASSIFIED':
      return 'cinema type not on record';
    case 'SEAT_CLASS_UNMAPPED':
      return 'seat classes not mapped';
    case 'PRICE_OVER_CEILING':
      return 'price outside the permitted range';
    default:
      return 'pricing not cleared for online sale';
  }
}

/** Blockers that are about WHERE the cinema is, so they stop every show there. */
const CINEMA_WIDE = new Set([
  'NO_PRICING_POLICY',
  'PRICING_POLICY_CONFLICT',
  'CINEMA_NOT_CLASSIFIED',
  'REGULATORY_PRICING_UNRESOLVED',
]);

export type CinemaSaleState =
  | { kind: 'SELLING' }
  /** Every upcoming show here is refused at checkout. */
  | { kind: 'NOT_SELLING'; reason: string; message: string; fixPath: string | null }
  /** Some seat categories or shows are refused; others sell. */
  | { kind: 'PARTLY'; reason: string; message: string; fixPath: string | null }
  /** Nothing upcoming to judge. */
  | { kind: 'NO_SHOWS' }
  /** The server was not asked, or would not say (an operator without access to readiness). */
  | { kind: 'UNKNOWN' };

/**
 * What the server's readiness report says about online sales at one cinema.
 *
 * Read from the SALES section only - the one built on `saleEligibility`, the same function
 * checkout refuses a sale with (#280). Its blocker codes arrive as `SALE_<code>`.
 */
export function cinemaSaleState(
  report: PilotReadinessReport | null | undefined,
  region: string | null | undefined,
): CinemaSaleState {
  if (!report) return { kind: 'UNKNOWN' };
  const sales = report.sections.find((s) => s.section === 'SALES');
  if (!sales || sales.checks.length === 0) return { kind: 'NO_SHOWS' };
  const blocked = sales.checks.filter((c) => c.level === 'BLOCKED');
  if (blocked.length === 0) {
    return sales.checks.some((c) => c.code === 'SALES_OPEN')
      ? { kind: 'SELLING' }
      : { kind: 'UNKNOWN' };
  }
  const wide = blocked.find((c) => CINEMA_WIDE.has(c.code.replace(/^SALE_/, '')));
  const lead = wide ?? blocked[0]!;
  return {
    kind: wide ? 'NOT_SELLING' : 'PARTLY',
    reason: shortSaleReason(lead.code, region),
    message: lead.message,
    fixPath: lead.fixPath,
  };
}

export interface SaleVerdict {
  /** True only when the server has confirmed a buyer can complete a purchase. */
  selling: boolean;
  /** "Selling", "Not selling: <reason>", or "Checking sale status". */
  label: string;
  tone: Tone;
  /** The longer explanation, when there is one. */
  detail: string | null;
  /** Where the organizer fixes it, relative to the console. */
  fixPath: string | null;
}

export interface ShowSaleInput {
  show: ShowRow;
  now: Date;
  timeZone: string | undefined;
  filmStatus: string;
  /**
   * The public show summary's `onlineBooking` - the server's per-show answer.
   * `undefined` while loading; `null` when it could not be read.
   */
  online: { open: boolean; closedTicketTypeIds: string[] } | null | undefined;
  cinema: CinemaSaleState;
}

const notSelling = (
  reason: string,
  detail: string | null,
  tone: Tone = 'neutral',
  fixPath: string | null = null,
): SaleVerdict => ({
  selling: false,
  label: `Not selling: ${reason}`,
  tone,
  detail,
  fixPath,
});

/**
 * One answer to "can somebody buy this show right now, and if not, why".
 *
 * Order matters and follows checkout's own order of refusals: the show's state, then its
 * booking window, then the regulatory check. The film being unpublished comes before the
 * regulatory check because a buyer cannot find the show at all.
 *
 * "Selling" needs a positive answer from the server. While that answer is loading the label
 * says so; when it cannot be read the label says THAT - never a hopeful "Selling".
 */
export function showSaleVerdict(i: ShowSaleInput): SaleVerdict {
  const { show, now } = i;
  if (show.status === 'CANCELLED') return notSelling('show cancelled', null, 'error');
  if (show.status === 'COMPLETED' || new Date(show.startsAt) <= now)
    return notSelling('show has started', null);
  const window = bookingWindowState(show, now);
  if (window === 'SALES_PAUSED')
    return notSelling(
      'sales paused',
      'Sales were paused by your team. Existing tickets stay valid.',
      'warning',
    );
  if (window === 'SALES_NOT_OPEN')
    return notSelling(
      `bookings open ${formatShowTime(show.salesStartAt!, i.timeZone)}`,
      'The booking window has not opened yet.',
    );
  if (window === 'BOOKING_CLOSED')
    return notSelling('booking closed', 'The booking window has closed.');
  if (i.filmStatus !== 'PUBLISHED')
    return notSelling(
      i.filmStatus === 'ARCHIVED' ? 'film archived' : 'film not published',
      'Buyers cannot find a film until it is published.',
      'neutral',
    );

  if (i.online === undefined)
    return {
      selling: false,
      label: 'Checking sale status',
      tone: 'neutral',
      detail: null,
      fixPath: null,
    };

  if (i.online === null) {
    // The server's answer could not be read. Say that, rather than guess either way.
    return {
      selling: false,
      label: 'Sale status unavailable',
      tone: 'neutral',
      detail: 'We could not confirm whether this show can be bought. Refresh to try again.',
      fixPath: null,
    };
  }

  const known = i.cinema.kind === 'NOT_SELLING' || i.cinema.kind === 'PARTLY' ? i.cinema : null;
  if (!i.online.open) {
    return notSelling(
      known ? known.reason : 'online booking not open',
      known
        ? known.message
        : 'Checkout refuses this show. Open the cinema readiness page for the reason.',
      'warning',
      known ? known.fixPath : null,
    );
  }
  return {
    selling: true,
    label: 'Selling',
    tone: 'success',
    detail:
      i.online.closedTicketTypeIds.length > 0
        ? `Some seat categories cannot be sold${known ? `: ${known.message}` : '.'}`
        : null,
    fixPath: i.online.closedTicketTypeIds.length > 0 && known ? known.fixPath : null,
  };
}

/**
 * A film's sale state across its cinemas, for the library card.
 *
 * Built from the cinema verdicts rather than one request per show: a library of thirty films
 * cannot ask about every showtime. It is still the server's answer - the readiness report's
 * SALES section runs the checkout check over every upcoming show at the cinema.
 */
export function filmSaleSummary(
  film: Pick<Movie, 'status'>,
  programme: FilmProgramme,
  rows: ShowRow[] | undefined,
  now: Date,
  cinemaState: (cinemaId: string) => CinemaSaleState,
): SaleVerdict & { exceptions: { cinema: string; reason: string }[] } {
  const none = { exceptions: [] as { cinema: string; reason: string }[] };
  if (film.status !== 'PUBLISHED')
    return {
      ...notSelling(film.status === 'ARCHIVED' ? 'film archived' : 'film not published', null),
      ...none,
    };
  if (programme.upcoming === 0)
    return {
      selling: false,
      label: 'No upcoming shows',
      tone: 'neutral',
      detail: null,
      fixPath: null,
      ...none,
    };

  const open = (rows ?? []).filter(
    (s) => isUpcoming(s, now) && bookingWindowState(s, now) === 'ON_SALE',
  );
  if (open.length === 0) return { ...notSelling('no show open for booking', null), ...none };

  const openCinemas = [...new Set(open.map((s) => s.cinemaId ?? 'unknown'))];
  const states = openCinemas.map((id) => ({
    id,
    name: programme.cinemas.find((c) => c.id === id)?.name ?? 'Unknown cinema',
    state: cinemaState(id),
  }));
  // Not yet answered, or not answerable for this person: say so, never a hopeful "Selling".
  if (states.some((s) => s.state.kind === 'UNKNOWN' || s.state.kind === 'NO_SHOWS'))
    return {
      selling: false,
      label: 'Sale status not confirmed',
      tone: 'neutral',
      detail: null,
      fixPath: null,
      ...none,
    };

  const exceptions = states
    .filter((s) => s.state.kind === 'NOT_SELLING' || s.state.kind === 'PARTLY')
    .map((s) => ({
      cinema: s.name,
      reason: (s.state as { reason: string }).reason,
    }));
  const selling = states.filter((s) => s.state.kind === 'SELLING' || s.state.kind === 'PARTLY');
  if (selling.length === 0) {
    const first = states[0]!.state as { reason: string; message: string; fixPath: string | null };
    return { ...notSelling(first.reason, first.message, 'warning', first.fixPath), exceptions };
  }
  return {
    selling: true,
    label: 'Selling',
    tone: 'success',
    detail: null,
    fixPath: null,
    exceptions,
  };
}
