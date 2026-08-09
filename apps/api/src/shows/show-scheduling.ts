/**
 * Show scheduling rules for cinema screens.
 *
 * Pure functions on plain data — no Prisma, no Nest. A screen's daily schedule is the one
 * piece of theater operations where a mistake is immediately physical: two films sold into
 * the same room at the same time cannot both be shown, and the audience finds out at the
 * door. That deserves logic that can be exhaustively tested without a database.
 *
 * The service layer supplies existing sessions and persists the result; everything about
 * WHETHER a slot is legal is decided here.
 */

/** A time window on a screen. `id` is absent for a proposed show that does not exist yet. */
export interface ShowWindow {
  id?: string;
  startsAt: Date;
  endsAt: Date;
}

/** Why a proposed show cannot be created. */
export type ScheduleRejection =
  | { reason: 'ENDS_BEFORE_IT_STARTS' }
  | { reason: 'IN_THE_PAST' }
  | { reason: 'DUPLICATE_IN_REQUEST'; duplicateOf: number }
  | { reason: 'OVERLAPS_EXISTING_SHOW'; conflictsWith: string; gapMinutes: number }
  | { reason: 'OVERLAPS_PROPOSED_SHOW'; conflictsWith: number; gapMinutes: number };

export interface ProposedShow extends ShowWindow {
  /** Position in the caller's request, so a conflict can be pointed at precisely. */
  index: number;
}

export interface ScheduleDecision {
  proposed: ProposedShow[];
  creatable: ProposedShow[];
  rejected: { show: ProposedShow; rejection: ScheduleRejection }[];
}

/**
 * The gap a screen needs between one show ending and the next starting.
 *
 * Real cinemas do not run back-to-back: the room has to empty, be cleaned, and refill, and
 * trailers absorb some of the slack but not all of it. Scheduling 14:00–16:00 and then
 * 16:00–18:00 looks fine in a spreadsheet and is not runnable.
 *
 * Configurable because it is a property of the venue's operation, not of software — a
 * multiplex with cleaning staff per screen turns around faster than a single-screen house.
 */
export const DEFAULT_TURNAROUND_MINUTES = 15;

const MINUTE_MS = 60_000;

/**
 * Whether two windows collide once the turnaround gap is taken into account.
 *
 * The gap is applied ONCE, to the pair, rather than added to each window's end. Adding it
 * to both would silently require double the configured turnaround between two shows, which
 * is not what an operator setting "15 minutes" means.
 */
export function windowsConflict(a: ShowWindow, b: ShowWindow, turnaroundMinutes: number): boolean {
  const gap = Math.max(0, turnaroundMinutes) * MINUTE_MS;
  return (
    a.startsAt.getTime() < b.endsAt.getTime() + gap &&
    b.startsAt.getTime() < a.endsAt.getTime() + gap
  );
}

/** Whole minutes between two windows; negative when they genuinely overlap. */
export function gapMinutesBetween(a: ShowWindow, b: ShowWindow): number {
  const [first, second] = a.startsAt.getTime() <= b.startsAt.getTime() ? [a, b] : [b, a];
  return Math.round((second.startsAt.getTime() - first.endsAt.getTime()) / MINUTE_MS);
}

const sameInstant = (a: ShowWindow, b: ShowWindow) =>
  a.startsAt.getTime() === b.startsAt.getTime() && a.endsAt.getTime() === b.endsAt.getTime();

/**
 * Decide which of a set of proposed shows may be created on one screen.
 *
 * Proposals are judged IN ORDER and each accepted one becomes an obstacle for those after
 * it, so a bulk request is checked against itself as well as against what is already
 * scheduled. Without that, submitting the same daily grid twice — or a range that overlaps
 * itself — would pass every individual check and then double-book the screen. Bulk
 * scheduling is exactly where this is easy to do by accident.
 *
 * Nothing is thrown. The caller gets every decision at once so an operator can see the
 * whole picture and fix it in one pass, rather than discovering conflicts one failed
 * request at a time.
 */
export function decideSchedule(params: {
  proposed: ProposedShow[];
  existing: ShowWindow[];
  turnaroundMinutes: number;
  now: Date;
}): ScheduleDecision {
  const { proposed, existing, turnaroundMinutes, now } = params;
  const creatable: ProposedShow[] = [];
  const rejected: { show: ProposedShow; rejection: ScheduleRejection }[] = [];

  for (const show of proposed) {
    if (show.endsAt.getTime() <= show.startsAt.getTime()) {
      rejected.push({ show, rejection: { reason: 'ENDS_BEFORE_IT_STARTS' } });
      continue;
    }
    if (show.startsAt.getTime() < now.getTime()) {
      // A show cannot open for sale into the past. Bulk date ranges that begin "today"
      // routinely generate a few of these; they are skipped rather than failing the batch.
      rejected.push({ show, rejection: { reason: 'IN_THE_PAST' } });
      continue;
    }

    const duplicate = creatable.find((c) => sameInstant(c, show));
    if (duplicate) {
      // An exact repeat is a different mistake from an overlap — usually a double-submitted
      // form or the same time listed twice — and saying so is more useful than "conflict".
      rejected.push({
        show,
        rejection: { reason: 'DUPLICATE_IN_REQUEST', duplicateOf: duplicate.index },
      });
      continue;
    }

    const clash = existing.find((e) => windowsConflict(show, e, turnaroundMinutes));
    if (clash) {
      rejected.push({
        show,
        rejection: {
          reason: 'OVERLAPS_EXISTING_SHOW',
          conflictsWith: clash.id ?? 'unknown',
          gapMinutes: gapMinutesBetween(show, clash),
        },
      });
      continue;
    }

    const selfClash = creatable.find((c) => windowsConflict(show, c, turnaroundMinutes));
    if (selfClash) {
      rejected.push({
        show,
        rejection: {
          reason: 'OVERLAPS_PROPOSED_SHOW',
          conflictsWith: selfClash.index,
          gapMinutes: gapMinutesBetween(show, selfClash),
        },
      });
      continue;
    }

    creatable.push(show);
  }

  return { proposed, creatable, rejected };
}

/**
 * Expand a date range and a set of daily start times into concrete shows.
 *
 * Times are wall-clock ("10:30") applied to each date, which is how a theater thinks and
 * publishes: a 10:30 show is 10:30 every day, and it does not shift because the server is
 * in another zone. `zonedDateFromParts` turns each (date, time) pair into an instant using
 * the venue's offset; the caller supplies that so this stays pure.
 *
 * The end time is derived from the film's runtime rather than asked for, because a show's
 * length is a property of the movie and making an operator retype it per slot is how
 * 90-minute films end up scheduled as 90-hour ones.
 */
export function expandSchedule(params: {
  dates: string[];
  times: string[];
  runtimeMinutes: number;
  toInstant: (date: string, time: string) => Date;
}): ProposedShow[] {
  const { dates, times, runtimeMinutes, toInstant } = params;
  const out: ProposedShow[] = [];
  let index = 0;
  // Dates outer, times inner: the natural reading order of a printed schedule, and it makes
  // the `index` in a conflict report correspond to what the operator sees on screen.
  for (const date of dates) {
    for (const time of times) {
      const startsAt = toInstant(date, time);
      out.push({
        index: index++,
        startsAt,
        endsAt: new Date(startsAt.getTime() + runtimeMinutes * MINUTE_MS),
      });
    }
  }
  return out;
}

/**
 * Every date from `from` to `to` inclusive, as YYYY-MM-DD.
 *
 * Iterates on a UTC calendar deliberately. These are date LABELS, not instants — they are
 * paired with a wall-clock time later — so stepping them through a local timezone would
 * drop or repeat a day across a DST boundary.
 */
export function datesInRange(from: string, to: string): string[] {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return [];
  const out: string[] = [];
  for (let d = start; d <= end; d = new Date(d.getTime() + 24 * 60 * MINUTE_MS)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
