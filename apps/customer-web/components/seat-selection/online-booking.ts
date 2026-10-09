import { ApiRequestError, type SeatLayoutResponse } from '@eticketsgo/web-kit';

/**
 * What the seat page does with "this show cannot be sold online".
 *
 * Pulled out of the page so it can be tested without rendering one: whether a seat can be
 * picked, and what the buyer reads when paying fails, are the two things QA found wrong.
 */

/** The API's reason for a sale refused by eligibility. Matches the server's constant. */
export const SALE_NOT_OPEN_REASON = 'SALE_NOT_OPEN';

/** True when a booking failed because the show cannot be sold online, not because of a seat. */
export function isSaleNotOpen(error: unknown): boolean {
  return error instanceof ApiRequestError && error.details?.reason === SALE_NOT_OPEN_REASON;
}

/**
 * What the buyer is told when "Proceed to pay" fails, kept on the page.
 *
 * A message key for the cases this page words itself - always for "not open", so the buyer
 * reads it in their own language and never the server's English - else the server's own
 * sentence, which is already written for a buyer.
 */
export function bookingFailure(
  error: unknown,
): { key: 'salesClosedBody' | 'bookingFailed' | 'seatTaken' } | { message: string } {
  if (isSaleNotOpen(error)) return { key: 'salesClosedBody' };
  if (error instanceof ApiRequestError) {
    return error.message ? { message: error.message } : { key: 'bookingFailed' };
  }
  return { key: 'seatTaken' };
}

/**
 * The layout as it may be bought from.
 *
 * A seat nobody can buy online is drawn BLOCKED - the status that already means "not for
 * sale" on this map, a disabled button whose accessible name says "unavailable" - rather than
 * as a seat that does nothing when pressed. Everything when the whole show is closed; only
 * the closed ticket types' seats otherwise, so the rest of the room still sells.
 *
 * Returns the same object when nothing is closed, so React keeps its memo.
 */
export function closeSeatsNotForSale(
  layout: SeatLayoutResponse | undefined,
  allClosed: boolean,
  closedTicketTypeIds: ReadonlySet<string>,
): SeatLayoutResponse | undefined {
  if (!layout || layout.view !== 'seats') return layout;
  if (!allClosed && closedTicketTypeIds.size === 0) return layout;
  const ticketTypeOf = new Map(layout.categories.map((c) => [c.id, c.ticketTypeId]));
  const closed = (categoryId: string) =>
    allClosed || closedTicketTypeIds.has(ticketTypeOf.get(categoryId) ?? '');
  return {
    ...layout,
    sections: layout.sections.map((section) => ({
      ...section,
      rows: section.rows.map((row) => ({
        ...row,
        seats: row.seats.map((seat) =>
          seat.status === 'AVAILABLE' && closed(seat.categoryId)
            ? { ...seat, status: 'BLOCKED' as const }
            : seat,
        ),
      })),
    })),
  };
}
