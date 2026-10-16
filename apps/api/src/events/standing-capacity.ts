import { HttpStatus } from '@nestjs/common';
import { AppException, ErrorCodes } from '../common/errors';

/**
 * A standing space's capacity, as a cap on what one session puts on sale.
 *
 * -- WHY A CAP AND NOT A HINT ---------------------------------------------------------------
 * A standing space ("Main Lawn, holds 100") said "set how many to sell, up to 100" and nothing
 * held anybody to it: a general-admission event at that lawn could put 500 tickets on sale and
 * the space never knew, because nothing tied the session to the space. Now a session can name
 * its standing space, and the sum of the quantities on sale for that session may not pass the
 * space's capacity.
 *
 * -- WHAT IT DOES NOT DO --------------------------------------------------------------------
 * It does not touch booking or inventory. The quantities it judges are the organizer's
 * `quantityTotal` per ticket type; the oversell guard at checkout is unchanged and still the
 * only thing that decides whether a ticket can be bought. This decides only how many may be
 * OFFERED.
 *
 * Existing over-cap data is never changed. A session already above the cap (put there before
 * this rule, or by lowering the space's capacity later) is flagged where it is shown, may LOWER
 * its quantities freely, and is refused only an INCREASE.
 */

/** Ticket types that count towards the cap: the ones on sale. An inactive type sells nothing. */
export function countsTowardsCap(status: string | null | undefined): boolean {
  return (status ?? 'ACTIVE') === 'ACTIVE';
}

export interface StandingCapInput {
  spaceName: string;
  capacity: number;
  /** Quantity on sale for the session from every OTHER active ticket type. */
  others: number;
  /** The quantity this ticket type would have after the change (0 when it stops counting). */
  next: number;
  /** The quantity this ticket type counts for today (0 when new or inactive). */
  previous: number;
}

/**
 * Null when the change is allowed, else the sentence to refuse it with.
 *
 * Allowed when the new total fits, and also when the change does not raise this ticket type's
 * count: a session already over the cap must still be able to come down to it one ticket type
 * at a time.
 */
export function standingCapProblem(i: StandingCapInput): string | null {
  const total = i.others + i.next;
  if (total <= i.capacity) return null;
  if (i.next <= i.previous) return null;
  const room = Math.max(0, i.capacity - i.others);
  const holds = `${i.spaceName} holds ${i.capacity.toLocaleString('en-US')} people.`;
  if (i.others === 0) {
    return `${holds} You cannot put ${i.next.toLocaleString('en-US')} tickets on sale for one session there. Lower the quantity, or raise the space's capacity under Venues & seating.`;
  }
  return `${holds} This session already has ${i.others.toLocaleString('en-US')} tickets on sale, so you can add ${
    room === 0 ? 'no more' : `at most ${room.toLocaleString('en-US')} more`
  }. Lower the quantity, or raise the space's capacity under Venues & seating.`;
}

export function refuseOverCap(message: string, capacity: number, total: number): never {
  throw new AppException(ErrorCodes.CONFLICT, message, HttpStatus.CONFLICT, {
    reason: 'STANDING_CAPACITY_EXCEEDED',
    capacity,
    total,
  });
}

/** How far one session's offer is above its space, for the places that flag it. 0 = within. */
export function overCapBy(capacity: number, onSale: number): number {
  return Math.max(0, onSale - capacity);
}
