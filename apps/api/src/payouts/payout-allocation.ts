import { organizerShareOfRefund, type SettlementRefundRow } from './currency-settlement.calculator';

/**
 * Which bookings a payout is made of, and what each one contributed.
 *
 * ── WHY THIS IS A SEPARATE PURE MODULE ─────────────────────────────────────────────
 * The payout's totals come from `calculateCurrencySettlement`. If allocations were derived
 * anywhere else - a second query, a second sum - the two would eventually disagree, and the
 * allocation ledger would explain a payout using money the payout never contained. That is worse
 * than having no ledger, because it looks like evidence.
 *
 * So this takes the SAME already-fetched rows the totals are computed from and splits them per
 * booking. It cannot drift from the totals because it is given the same input, and it reuses the
 * calculator's own `organizerShareOfRefund` rather than copying the clamp.
 *
 * Arithmetic only: no query, no clock, no currency conversion, no eligibility. Which bookings are
 * eligible is `payableBookingWhere`'s single answer, decided before anything reaches here.
 */

/** One eligible booking, as the caller's single eligibility query returned it. */
export interface AllocationBookingRow {
  id: string;
  eventId: string;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  bookingFeeMinor: number;
  paymentFeeMinor: number;
  organizerFeeMinor: number;
}

/**
 * One completed refund this payout deducts, naming the booking it returns.
 *
 * The refund window is NOT the booking window: revenue is selected on `booking.confirmedAt` and
 * refunds on `refund.updatedAt`, so a payout can legitimately deduct a refund for a booking its
 * own revenue query never returned. Such a booking still gets an allocation - with no revenue
 * components and a negative net - because every part of a payout's net has to be attributable to
 * something. Dropping it would make the allocation sum disagree with `netMinor`.
 */
export interface AllocationRefundRow {
  bookingId: string;
  eventId: string;
  currency: string;
  amountMinor: number;
  taxAddedMinor: number | null;
}

/** One booking's contribution, ready to persist. Currency is already case-folded. */
export interface AllocationDraft {
  bookingId: string;
  eventId: string;
  currency: string;
  allocatedNetMinor: number;
  subtotalMinor: number;
  discountMinor: number;
  organizerFeeMinor: number;
  refundShareMinor: number;
  bookingFeeMinor: number;
  paymentFeeMinor: number;
}

export interface AllocationInput {
  bookings: readonly AllocationBookingRow[];
  refunds: readonly AllocationRefundRow[];
}

/**
 * Every booking's contribution, keyed by the payout currency it belongs to.
 *
 * Case is folded with `toUpperCase` exactly as `calculateCurrencySettlement` folds it, so a
 * database holding both `inr` and `INR` produces one INR payout and one INR allocation set. A
 * different folding here would strand allocations under a currency no payout was written for.
 *
 * Per booking:
 *
 *   allocatedNetMinor = subtotalMinor − discountMinor − organizerFeeMinor − refundShareMinor
 *
 * mirroring `net = gross − discount − organizerFee − refund` term for term. `bookingFeeMinor` and
 * `paymentFeeMinor` are carried for reporting and deliberately absent from that equation, because
 * they are borne by the customer on top of the ticket price - the same reason the calculator
 * reports and does not deduct them.
 */
export function allocateCurrencySettlement(input: AllocationInput): Map<string, AllocationDraft[]> {
  /** currency -> bookingId -> draft, so a refund can find the booking's own row. */
  const byCurrency = new Map<string, Map<string, AllocationDraft>>();

  const slot = (currency: string): Map<string, AllocationDraft> => {
    const key = currency.toUpperCase();
    const existing = byCurrency.get(key);
    if (existing) return existing;
    const fresh = new Map<string, AllocationDraft>();
    byCurrency.set(key, fresh);
    return fresh;
  };

  for (const booking of input.bookings) {
    const currency = booking.currency.toUpperCase();
    const drafts = slot(currency);
    const existing = drafts.get(booking.id);
    /*
      The eligibility query returns a booking at most once, so a duplicate id means the caller
      passed the same row twice. Adding it would double-count the organizer's revenue, which the
      database would then refuse on the unique key - after the totals were already computed. Fail
      here, where the reason is still legible.
    */
    if (existing) {
      throw new Error(`payout allocation: booking ${booking.id} appeared twice in the input`);
    }
    drafts.set(booking.id, {
      bookingId: booking.id,
      eventId: booking.eventId,
      currency,
      subtotalMinor: booking.subtotalMinor,
      discountMinor: booking.discountMinor,
      organizerFeeMinor: booking.organizerFeeMinor,
      refundShareMinor: 0,
      bookingFeeMinor: booking.bookingFeeMinor,
      paymentFeeMinor: booking.paymentFeeMinor,
      allocatedNetMinor: booking.subtotalMinor - booking.discountMinor - booking.organizerFeeMinor,
    });
  }

  for (const refund of input.refunds) {
    const currency = refund.currency.toUpperCase();
    const drafts = slot(currency);
    const share = organizerShareOfRefund(refund as SettlementRefundRow);

    const existing = drafts.get(refund.bookingId);
    if (existing) {
      existing.refundShareMinor += share;
      existing.allocatedNetMinor -= share;
      continue;
    }
    /*
      A refund whose booking is outside this payout's revenue window. It is a pure clawback: no
      revenue to show, a negative contribution, and still attributable to the booking it came
      from. See `AllocationRefundRow`.
    */
    drafts.set(refund.bookingId, {
      bookingId: refund.bookingId,
      eventId: refund.eventId,
      currency,
      subtotalMinor: 0,
      discountMinor: 0,
      organizerFeeMinor: 0,
      refundShareMinor: share,
      bookingFeeMinor: 0,
      paymentFeeMinor: 0,
      allocatedNetMinor: -share,
    });
  }

  const out = new Map<string, AllocationDraft[]>();
  for (const [currency, drafts] of byCurrency) {
    // Sorted by booking id so a payout's allocations are written in a stable, diffable order.
    out.set(
      currency,
      [...drafts.values()].sort((a, b) => (a.bookingId < b.bookingId ? -1 : 1)),
    );
  }
  return out;
}

/** The allocation sum for one currency. */
export function allocatedNet(drafts: readonly AllocationDraft[]): number {
  return drafts.reduce((total, draft) => total + draft.allocatedNetMinor, 0);
}
