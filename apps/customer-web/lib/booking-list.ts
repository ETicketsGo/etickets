/**
 * Which bookings "My bookings" opens with.
 *
 * The list was every booking ever made, newest first, with each abandoned cart that timed out
 * among them - 60 rows on QA, most of them holds nobody wanted. The page opens on the ones a
 * person acts on: not ended, not expired, not cancelled. The others stay one tap away ("Show
 * past and expired"); nothing is removed.
 */

/** A booking in these states is finished business, whatever date the show has. */
const CLOSED_STATUSES = new Set(['EXPIRED', 'CANCELLED', 'REFUNDED']);

/**
 * How long after the start a show still counts as "now". A film runs for hours and a buyer may
 * open this on the way out to find the ticket; `eventSession` has no end time here.
 */
const STILL_ON_MS = 6 * 60 * 60 * 1000;

export function isCurrentBooking(
  row: { status: string; eventSession: { startsAt: string } },
  now: number,
): boolean {
  if (CLOSED_STATUSES.has(row.status)) return false;
  const start = new Date(row.eventSession.startsAt).getTime();
  // An unreadable date is shown rather than hidden: hiding is the costlier mistake.
  return Number.isNaN(start) ? true : start + STILL_ON_MS >= now;
}

/** Splits a list into what opens by default and what the toggle adds. */
export function splitBookings<T extends { status: string; eventSession: { startsAt: string } }>(
  rows: T[],
  now: number,
): { current: T[]; past: T[] } {
  const current: T[] = [];
  const past: T[] = [];
  for (const row of rows) (isCurrentBooking(row, now) ? current : past).push(row);
  return { current, past };
}
