import type { EventDetail, EventSession } from './schema';

/**
 * What the app says when a show needs a seat map it cannot draw.
 *
 * The app picks seats only on a cinema's grid. A seated theatre, arena or stadium show is
 * chosen on the website's venue map, and asking the API to book "two tickets" for it is
 * refused at the last step — after the buyer has typed their details and committed to a
 * price. Saying so plainly, before anything is held, is the honest version of that refusal.
 */
export const SEAT_SELECTION_ON_WEBSITE =
  'Seat selection for this show is available on the website.';

export class SeatSelectionUnavailableError extends Error {
  constructor() {
    super(SEAT_SELECTION_ON_WEBSITE);
    this.name = 'SeatSelectionUnavailableError';
  }
}

/**
 * Whether booking this session means choosing seats.
 *
 * The server's `seatBased` decides when it is sent. Only an older API that omits it falls
 * back to the experience type, which is how the app decided before sessions said so.
 */
export function requiresSeatSelection(
  session: Pick<EventSession, 'seatBased'> | undefined,
  experienceType: string | undefined,
): boolean {
  if (typeof session?.seatBased === 'boolean') return session.seatBased;
  return experienceType === 'MOVIE';
}

/**
 * True when a booking would ask for tickets to a seated session without naming the seats.
 *
 * Only an explicit `seatBased: true` blocks: an unknown answer lets the request through and
 * the API remains the authority, rather than the app refusing a sale it cannot be sure of.
 */
export function isQuantityOnlyForSeatedSession(
  session: Pick<EventSession, 'seatBased'> | undefined,
  items: readonly { seatIds?: string[] }[],
): boolean {
  return session?.seatBased === true && items.some((item) => !item.seatIds?.length);
}

/** The session with this id, from whichever loaded event carries it. */
export function findSessionInEvents(
  events: readonly (EventDetail | undefined)[],
  sessionId: string,
): EventSession | undefined {
  for (const event of events) {
    const found = event?.sessions?.find((s) => s.id === sessionId);
    if (found) return found;
  }
  return undefined;
}
