/**
 * What an organizer may do to a show, and when.
 *
 * Pure policy over plain data, for the same reason the overlap rules are: these decide
 * whether real money and real seats move, and they should be provable without a database.
 * The service supplies the show's current state and a count of what is booked against it;
 * everything about WHETHER an operation is allowed is decided here.
 *
 * ── THE STATES ────────────────────────────────────────────────────────────────────
 * `SessionStatus` is SCHEDULED | PAUSED | CANCELLED | COMPLETED. PAUSED was added for
 * sales control; the other three already existed and are unchanged.
 *
 * PAUSED rather than a separate `salesPaused` boolean, deliberately. Booking creation
 * already refuses anything that is not SCHEDULED, and the public showtime query already
 * filters on it, so a new status is enforced by code that exists. A parallel boolean would
 * have needed both call sites taught about it, and the failure mode of forgetting one is
 * selling tickets to a show the operator believes is closed.
 */

/** Session states. Mirrors the Prisma enum; duplicated as a literal union to keep this pure. */
export type ShowState = 'SCHEDULED' | 'PAUSED' | 'CANCELLED' | 'COMPLETED';

export type ShowOperation = 'PAUSE' | 'REOPEN' | 'CANCEL' | 'EDIT_TIME' | 'EDIT_SCREEN';

/** What is booked against a show right now. */
export interface ShowCommitments {
  /** Unpaid holds that have not lapsed. */
  activeHolds: number;
  /** Bookings awaiting payment. */
  pendingPayment: number;
  /** Paid bookings. Money has moved. */
  confirmed: number;
}

export const NO_COMMITMENTS: ShowCommitments = {
  activeHolds: 0,
  pendingPayment: 0,
  confirmed: 0,
};

export type OperationVerdict =
  | { allowed: true }
  | { allowed: true; idempotent: true }
  | { allowed: false; code: string; message: string };

const refuse = (code: string, message: string): OperationVerdict => ({
  allowed: false,
  code,
  message,
});

const ALLOW: OperationVerdict = { allowed: true };
const ALREADY: OperationVerdict = { allowed: true, idempotent: true };

/** A show that has started or finished is history; nothing may be done to it. */
function refuseIfOver(state: ShowState, startsAt: Date, now: Date): OperationVerdict | null {
  if (state === 'COMPLETED') {
    return refuse('SHOW_ALREADY_COMPLETED', 'This show has already finished.');
  }
  if (startsAt.getTime() <= now.getTime()) {
    return refuse('SHOW_ALREADY_STARTED', 'This show has already started.');
  }
  return null;
}

/**
 * Decide whether an operation may proceed.
 *
 * Repeating an operation that is already in effect returns `idempotent: true` rather than
 * an error. Pausing a paused show is not a mistake worth failing a request over — an
 * operator double-clicking, or a retry after a timed-out response, should land on the
 * intended state rather than an error that invites them to try something else.
 */
export function evaluateOperation(params: {
  operation: ShowOperation;
  state: ShowState;
  startsAt: Date;
  commitments: ShowCommitments;
  now: Date;
}): OperationVerdict {
  const { operation, state, startsAt, commitments, now } = params;

  // Cancelled is terminal for everything. Re-cancelling is the one exception, handled below.
  if (state === 'CANCELLED' && operation !== 'CANCEL') {
    return refuse('SHOW_CANCELLED', 'This show has been cancelled.');
  }

  switch (operation) {
    case 'PAUSE': {
      if (state === 'PAUSED') return ALREADY;
      const over = refuseIfOver(state, startsAt, now);
      if (over) return over;
      // Pausing is always safe regardless of what is booked: it stops NEW sales and
      // touches nothing that already exists.
      return ALLOW;
    }

    case 'REOPEN': {
      if (state === 'SCHEDULED') return ALREADY;
      if (state !== 'PAUSED') {
        return refuse('SHOW_NOT_PAUSED', 'Only a paused show can be reopened.');
      }
      const over = refuseIfOver(state, startsAt, now);
      if (over) return over;
      return ALLOW;
    }

    case 'CANCEL': {
      if (state === 'CANCELLED') return ALREADY;
      if (state === 'COMPLETED') {
        return refuse('SHOW_ALREADY_COMPLETED', 'A finished show cannot be cancelled.');
      }
      // A started show is deliberately NOT refused. A projector failing ten minutes in is
      // exactly when an operator needs to cancel and refund, and refusing would leave them
      // with no way to record it.
      return ALLOW;
    }

    case 'EDIT_TIME': {
      const over = refuseIfOver(state, startsAt, now);
      if (over) return over;
      if (commitments.confirmed > 0) {
        // Someone has paid to be somewhere at a stated time. Moving it silently is the
        // single worst thing this API could do; the operator must cancel and rebook so the
        // customer is told.
        return refuse(
          'SHOW_HAS_CONFIRMED_BOOKINGS',
          'This show has confirmed bookings and cannot be moved. Cancel it instead so customers are notified.',
        );
      }
      if (commitments.pendingPayment > 0 || commitments.activeHolds > 0) {
        // A customer is mid-checkout looking at a time that would change under them.
        return refuse(
          'SHOW_HAS_ACTIVE_CHECKOUTS',
          'Someone is currently booking this show. Try again once their hold expires.',
        );
      }
      return ALLOW;
    }

    case 'EDIT_SCREEN': {
      const over = refuseIfOver(state, startsAt, now);
      if (over) return over;
      // Seats belong to a screen's layout. Moving a show to a different screen invalidates
      // every seat identifier already issued against it, so ANY commitment blocks it —
      // including an unpaid hold, whose seats would otherwise silently cease to exist.
      if (
        commitments.confirmed > 0 ||
        commitments.pendingPayment > 0 ||
        commitments.activeHolds > 0
      ) {
        return refuse(
          'SHOW_HAS_BOOKINGS',
          'Seats are already allocated on the current screen. Cancel this show and schedule it on the other screen instead.',
        );
      }
      return ALLOW;
    }
  }
}

/**
 * Field mutability, as the mission asks it to be classified.
 *
 * A: safe before any booking. B: safe with bookings. C: never after publication.
 * D: requires cancel-and-recreate.
 *
 * Exported so the classification is a checkable fact rather than a comment, and so a future
 * field has an obvious place to be reasoned about instead of quietly becoming editable.
 */
export const FIELD_MUTABILITY = {
  /** Moving a show is safe only while nobody is committed to the old time. */
  startsAt: 'A',
  /** Derived from startsAt + runtime; same rule. */
  endsAt: 'A',
  /**
   * Sales windows may be tightened or extended at any time. They gate NEW purchases and
   * cannot invalidate an existing one.
   */
  salesStartAt: 'B',
  salesEndAt: 'B',
  /** Price changes never apply retroactively: bookings snapshot their totals. */
  priceMinor: 'B',
  /** Every issued seat identifier belongs to the old screen's layout. */
  screenId: 'D',
  /** Changing the film changes the product; nothing about the old booking still applies. */
  movieId: 'D',
  /** Seat inventory is created per session from the layout at scheduling time. */
  seatMapId: 'C',
} as const satisfies Record<string, 'A' | 'B' | 'C' | 'D'>;

/**
 * Customer-facing bookability, in one place.
 *
 * Extends the existing AVAILABLE / LIMITED / SOLD_OUT vocabulary rather than adding a
 * parallel flag, so clients keep reading one field. A customer needs to tell "cannot buy
 * right now" apart from "gone" — a paused show that simply vanished from the listing looks
 * like a bug to someone who was about to book it.
 *
 * Order matters: a cancelled show is cancelled whether or not it also sold out, and a
 * paused show should not advertise remaining seats it will not sell.
 */
export type PublicShowState =
  'AVAILABLE' | 'LIMITED' | 'SOLD_OUT' | 'SALES_PAUSED' | 'BOOKING_CLOSED' | 'CANCELLED';

export function publicShowState(params: {
  state: ShowState;
  seatsRemaining: number | null;
  limitedThreshold: number;
  salesOpenAt: Date | null;
  salesCloseAt: Date | null;
  now: Date;
}): PublicShowState {
  const { state, seatsRemaining, limitedThreshold, salesOpenAt, salesCloseAt, now } = params;

  if (state === 'CANCELLED') return 'CANCELLED';
  if (state === 'PAUSED') return 'SALES_PAUSED';
  // A finished show is not "cancelled", but it is equally unbookable and saying
  // BOOKING_CLOSED is the honest description.
  if (state === 'COMPLETED') return 'BOOKING_CLOSED';

  /**
   * Boundaries match the SERVER exactly, and that is the point rather than a detail.
   *
   * Booking creation rejects with `salesStartAt > now` and `salesEndAt < now`, so the
   * open instant is inclusive and so is the close. If this view used a different rule —
   * an exclusive close reads more naturally — there would be one instant where the
   * listing says "closed" on a show the server would happily sell, and another where it
   * offers a Book button the server refuses. The client is not authoritative, so it must
   * agree with what the server will actually do.
   */
  if (salesOpenAt && now.getTime() < salesOpenAt.getTime()) return 'BOOKING_CLOSED';
  if (salesCloseAt && now.getTime() > salesCloseAt.getTime()) return 'BOOKING_CLOSED';

  if (seatsRemaining === null) return 'AVAILABLE';
  if (seatsRemaining <= 0) return 'SOLD_OUT';
  if (seatsRemaining <= limitedThreshold) return 'LIMITED';
  return 'AVAILABLE';
}

/** Whether a customer may start a purchase. The single question every client asks. */
export const isBookable = (s: PublicShowState): boolean => s === 'AVAILABLE' || s === 'LIMITED';
