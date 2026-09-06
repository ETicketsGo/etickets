import type {
  ExternalCinema,
  ExternalMovie,
  ExternalScreen,
  ExternalSeat,
  ExternalSeatCategory,
  ExternalShow,
} from '../../cinema-capabilities.interface';

/**
 * A sandbox cinema, invented in full.
 *
 * ── THIS IS NOT QUBE ───────────────────────────────────────────────────────────────
 * Nothing here is derived from Qube Cinema's real API, documentation, identifiers,
 * payloads or behaviour. We have none of those. Every id, field name, film, seat and price
 * below was made up to exercise OUR architecture against a plausible remote cinema POS.
 *
 * When official Qube documentation arrives, expect essentially all of this to be wrong in
 * detail — different id shapes, different seat-state vocabulary, different hold semantics.
 * That is the point of the exercise: if replacing this file and the transport in
 * `qube-mock.provider.ts` is the bulk of the work, the seam held.
 *
 * The films are fictional for the same reason. Naming a real release would date the fixture
 * and imply a licensing relationship that does not exist.
 *
 * ── WHY THE TIMES ARE BUILT FROM A ZONE AND NOT A LITERAL ──────────────────────────
 * Showtimes are wall-clock facts about a building: 19:30 in Hyderabad is 19:30 whatever the
 * server thinks the date is. They are constructed by resolving the cinema's local time
 * through `Asia/Kolkata`, so this fixture produces the same schedule on a laptop in London
 * and a container in us-east-1. A hardcoded ISO instant would silently drift.
 */

export const QUBE_MOCK_PROVIDER_CODE = 'QUBE_MOCK';

export const QUBE_MOCK_CINEMA: ExternalCinema = {
  externalId: 'QBC-HYD-0001',
  name: 'ETG Qube Sandbox Cinema Hyderabad',
  city: 'Hyderabad',
  timezone: 'Asia/Kolkata',
  raw: { sandbox: true, note: 'Invented fixture. Not a real Qube cinema.' },
};

export const QUBE_MOCK_SCREENS: ExternalScreen[] = [
  {
    externalId: 'QBS-HYD-0001-S1',
    cinemaExternalId: QUBE_MOCK_CINEMA.externalId,
    name: 'Screen 1',
  },
  {
    externalId: 'QBS-HYD-0001-S2',
    cinemaExternalId: QUBE_MOCK_CINEMA.externalId,
    name: 'Screen 2',
  },
  {
    externalId: 'QBS-HYD-0001-S3',
    cinemaExternalId: QUBE_MOCK_CINEMA.externalId,
    name: 'Screen 3',
  },
];

export const QUBE_MOCK_MOVIES: ExternalMovie[] = [
  {
    externalId: 'QBM-TE-1001',
    title: 'Veera Simham',
    language: 'te',
    runtimeMinutes: 152,
    certificate: 'UA',
    releaseDate: '2026-08-14',
    posterUrl: 'https://placeholder.invalid/veera-simham.jpg',
    raw: { fictional: true },
  },
  {
    externalId: 'QBM-TE-1002',
    title: 'Hyderabad Express',
    language: 'te',
    runtimeMinutes: 138,
    certificate: 'U',
    releaseDate: '2026-09-02',
    posterUrl: 'https://placeholder.invalid/hyderabad-express.jpg',
    raw: { fictional: true },
  },
];

/**
 * Seat categories with the prices the remote system believes.
 *
 * ADVISORY ONLY. ETicketsGo prices its own sales through its own pricing, fee and tax
 * engine — including the Andhra Pradesh rate ceilings, which a remote POS knows nothing
 * about. These exist so an operator can see what the provider thinks and reconcile a
 * disagreement, never so a number from a vendor is charged to a customer unchecked.
 */
export const QUBE_MOCK_CATEGORIES: ExternalSeatCategory[] = [
  { externalId: 'QBCAT-NORMAL', name: 'Normal', priceMinor: 18_000, currency: 'INR' },
  { externalId: 'QBCAT-EXEC', name: 'Executive', priceMinor: 22_000, currency: 'INR' },
  { externalId: 'QBCAT-PREMIUM', name: 'Premium', priceMinor: 28_000, currency: 'INR' },
  { externalId: 'QBCAT-RECLINER', name: 'Recliner', priceMinor: 45_000, currency: 'INR' },
];

/**
 * Showtimes as the cinema advertises them, in its own local wall clock.
 *
 * Spaced three hours apart, which is not decoration: the longest film here runs 152 minutes
 * and a room needs turning round between screenings. The first version of this fixture used
 * tighter, more natural-looking times and produced a schedule no cinema could actually run —
 * the 16:45 show of a 2h32 film ends thirteen minutes before the 19:30 one starts. Nothing in
 * the sandbox noticed, because nothing in the sandbox schedules a room; the platform's own
 * scheduler did, the moment the catalogue was imported into it.
 */
export const QUBE_MOCK_SHOW_TIMES = ['10:30', '13:30', '16:30', '19:30', '22:45'] as const;

/**
 * The instant a local wall-clock time in a given zone actually occurs.
 *
 * Done by formatting a candidate instant back into the target zone and correcting the
 * difference, rather than by adding a fixed offset. India is +05:30 today and a fixed offset
 * would still be wrong for any zone that observes DST — and this helper is the one every
 * other zone would reuse.
 */
export function instantAtLocalTime(dayOffset: number, hhmm: string, timeZone: string): Date {
  const [hh, mm] = hhmm.split(':').map(Number);
  const base = new Date();
  base.setUTCDate(base.getUTCDate() + dayOffset);

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(base);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const y = get('year');
  const mo = get('month');
  const d = get('day');

  // First guess: treat the wall clock as if it were UTC, then measure how far out it is.
  const guess = Date.UTC(y, mo - 1, d, hh, mm, 0, 0);
  const seen = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(guess));
  const sg = (t: string) => Number(seen.find((p) => p.type === t)?.value);
  const seenUtc = Date.UTC(sg('year'), sg('month') - 1, sg('day'), sg('hour') % 24, sg('minute'));
  return new Date(guess - (seenUtc - guess));
}

/** Shows for `days` days from today, every listed time, alternating films across screens. */
export function buildShows(days = 3): ExternalShow[] {
  const shows: ExternalShow[] = [];
  const tz = QUBE_MOCK_CINEMA.timezone!;
  for (let day = 0; day < days; day++) {
    QUBE_MOCK_SCREENS.forEach((screen, screenIndex) => {
      QUBE_MOCK_SHOW_TIMES.forEach((time, timeIndex) => {
        const movie = QUBE_MOCK_MOVIES[(screenIndex + timeIndex) % QUBE_MOCK_MOVIES.length];
        const startsAt = instantAtLocalTime(day, time, tz);
        shows.push({
          // Deterministic and stable across restarts: the mapping layer keys on this, and an
          // id that changed on every boot would create a new internal show every sync.
          externalId: `QBSH-${screen.externalId}-D${day}-${time.replace(':', '')}`,
          cinemaExternalId: QUBE_MOCK_CINEMA.externalId,
          screenExternalId: screen.externalId,
          movieExternalId: movie.externalId,
          startsAt,
          endsAt: new Date(startsAt.getTime() + (movie.runtimeMinutes ?? 150) * 60_000),
          currency: 'INR',
          raw: { localTime: time, localDayOffset: day, timezone: tz },
        });
      });
    });
  }
  return shows;
}

/**
 * A plausible Indian multiplex layout: 10 rows, an aisle, a wheelchair bay, a recliner row.
 *
 * Rows A–C are Normal, D–F Executive, G–H Premium, J recliner. Row I is skipped, as most
 * venues do — it reads as a 1 on a printed ticket.
 */
const ROW_CATEGORY: Record<string, string> = {
  A: 'QBCAT-NORMAL',
  B: 'QBCAT-NORMAL',
  C: 'QBCAT-NORMAL',
  D: 'QBCAT-EXEC',
  E: 'QBCAT-EXEC',
  F: 'QBCAT-EXEC',
  G: 'QBCAT-PREMIUM',
  H: 'QBCAT-PREMIUM',
  J: 'QBCAT-RECLINER',
};

/**
 * The seats in a ROOM, not in a showing.
 *
 * A seat is a physical position: F10 is the same chair at the matinee and at the late show,
 * and only its AVAILABILITY differs between them. Keying seat identity on the show would mean
 * a new set of seat ids five times a day, and a mapping table that grew without bound while
 * describing one unchanging room.
 *
 * Whether Qube models it this way is an open question — `qube-readiness.md` asks whether the
 * layout is per-show or per-screen — and if the answer is per-show, the mapping layer absorbs
 * it: this is exactly the kind of thing the seam exists to isolate.
 */
export function buildSeats(screenExternalId: string): ExternalSeat[] {
  const seats: ExternalSeat[] = [];
  for (const [row, categoryExternalId] of Object.entries(ROW_CATEGORY)) {
    // Recliners are wider, so there are fewer of them — the same reason a real room has.
    const count = categoryExternalId === 'QBCAT-RECLINER' ? 8 : 16;
    for (let n = 1; n <= count; n++) {
      /*
        A gap where the aisle runs. Represented as a POSITION rather than omitted, because a
        layout that simply skips numbers cannot tell "there is an aisle here" from "seat 8 was
        removed", and the two render differently.
      */
      const isAisle = count === 16 && (n === 8 || n === 9);
      // Two wheelchair spaces at the end of the last normal row, where the ramp reaches.
      const isWheelchair = row === 'C' && (n === 15 || n === 16);
      seats.push({
        externalId: `QBSEAT-${screenExternalId}-${row}${n}`,
        label: `${row}${n}`,
        row,
        number: n,
        categoryExternalId,
        state: 'AVAILABLE',
        kind: isAisle ? 'GAP' : isWheelchair ? 'WHEELCHAIR' : 'SEAT',
      });
    }
  }
  return seats;
}

/**
 * Seats the venue has taken off sale, and seats already sold, so the mock is not a room
 * where everything is always free.
 *
 * Keyed by label rather than external id because it describes the ROOM, and the room is the
 * same for every show; the ids are per-show.
 */
export const QUBE_MOCK_BLOCKED_LABELS = ['A1', 'A2'];
export const QUBE_MOCK_PRESOLD_LABELS = ['G5', 'G6', 'H1'];
