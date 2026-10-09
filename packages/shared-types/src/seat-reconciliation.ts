/**
 * One set of numbers for a seat layout, whoever is showing it.
 *
 * ── WHY THIS IS SHARED ─────────────────────────────────────────────────────────────
 * The same room used to be counted in three places by three pieces of arithmetic: the
 * generator counted its draft, the layouts page counted "seats" from the API, and nothing
 * counted the buyer's view at all. Each was right about something slightly different -
 * positions, or non-aisle seats, or what a session can sell - so one room could be described
 * as 162, 153 and 150 seats on three screens an organizer moves between in a minute.
 *
 * Every screen that shows a layout now reduces it to kind counts and passes them through
 * here, so the words "positions", "aisles", "accessible" and "bookable" mean one thing.
 *
 * ── THE RULE IT ENCODES ────────────────────────────────────────────────────────────
 * It is the API's rule, written down once for the client: a GAP is an aisle and is never
 * sold; every other position is a seat somebody can buy, accessible places included. A
 * BLOCKED seat is a property of one session (an operator override on its ShowSeat), never of
 * the layout, so a layout has none and only a session view passes a count.
 */

/** How many seats of one `Seat.kind` a layout holds. */
export interface SeatKindCount {
  kind: string;
  count: number;
}

export interface SeatReconciliation {
  /** Every position on the plan, aisles included. */
  positions: number;
  /** Aisle positions. Drawn, never sold. */
  aisles: number;
  /** Seats an operator withdrew from ONE session. Always 0 for a layout on its own. */
  blocked: number;
  /** Wheelchair spaces. Bookable, so also counted in `bookable`. */
  wheelchair: number;
  /** Companion seats beside them. Bookable, so also counted in `bookable`. */
  companion: number;
  /** wheelchair + companion. */
  accessible: number;
  /** Seats a buyer can actually choose: positions - aisles - blocked. */
  bookable: number;
}

/** Count seats by kind. Unknown kinds are kept as they are; `reconcileSeats` treats them as seats. */
export function countSeatKinds(seats: Iterable<{ kind: string }>): SeatKindCount[] {
  const counts = new Map<string, number>();
  for (const seat of seats) counts.set(seat.kind, (counts.get(seat.kind) ?? 0) + 1);
  return [...counts.entries()].map(([kind, count]) => ({ kind, count }));
}

/**
 * Reduce kind counts to the numbers every layout screen shows.
 *
 * An unknown kind is counted as a seat, matching the API, which sells everything that is not
 * a GAP. Hiding an unrecognised kind here would make the console report fewer seats than the
 * session actually puts on sale.
 *
 * `blocked` is clamped to what is left after aisles, so a stale or double-counted figure can
 * never drive `bookable` below zero.
 */
export function reconcileSeats(
  counts: Iterable<SeatKindCount>,
  options: { blocked?: number } = {},
): SeatReconciliation {
  let positions = 0;
  let aisles = 0;
  let wheelchair = 0;
  let companion = 0;
  for (const { kind, count } of counts) {
    if (!Number.isFinite(count) || count <= 0) continue;
    positions += count;
    if (kind === 'GAP') aisles += count;
    else if (kind === 'WHEELCHAIR') wheelchair += count;
    else if (kind === 'COMPANION') companion += count;
  }
  const seats = positions - aisles;
  const blocked = Math.min(seats, Math.max(0, Math.floor(options.blocked ?? 0)));
  return {
    positions,
    aisles,
    blocked,
    wheelchair,
    companion,
    accessible: wheelchair + companion,
    bookable: seats - blocked,
  };
}
