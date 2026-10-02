/**
 * What one currency's settlement comes to, as arithmetic and nothing else.
 *
 * ── WHY THIS IS ITS OWN MODULE ─────────────────────────────────────────────────────
 * This sum decides what an organizer is paid. It lived inside `PayoutsService.settle()`, a
 * `private` method taking a `Prisma.TransactionClient`, so the only way to ask "what is this
 * organizer owed" was to open a transaction and WRITE a payout. Every read-only surface that
 * needed the same answer - a finance summary, a dashboard, a report - therefore had to re-derive
 * it, and two derivations of the same money eventually disagree.
 *
 * Extracted so that the payout-writing path and any read model call the SAME function. There is
 * one authoritative settlement calculation and this is it.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ─────────────────────────────────────────────
 * It is arithmetic, not policy. It does not query or write, does not read the clock or the
 * environment, does not know who is asking, and does not convert currencies. Everything it needs
 * arrives as already-fetched, already-normalised rows.
 *
 * In particular it does NOT decide eligibility. Which bookings belong in a settlement - the hold
 * period, events whose money a provider transfer has already claimed, revenue an earlier payout
 * already settled - is a question about WHICH ROWS, answered by the caller's query. Eligibility
 * and arithmetic are different concerns, and folding them together is how a rule about hold days
 * ends up buried in a sum.
 *
 * ── MONEY IS INTEGER MINOR UNITS, ALWAYS ───────────────────────────────────────────
 * Every amount in and out is an integer in the currency's minor unit. There is no division and no
 * floating point anywhere in this file, so there is nothing to round and no rounding rule to get
 * wrong.
 */

/** One currency's settlement figures. */
export interface CurrencySettlement {
  currency: string;
  gross: number;
  /** Coupon discounts, which come out of the organizer's ticket revenue. */
  discount: number;
  bookingFee: number;
  paymentFee: number;
  organizerFee: number;
  refund: number;
  net: number;
}

/**
 * Revenue already summed by the caller's query, one row per currency as the database grouped it.
 *
 * Several rows may share a currency once case is folded - a database holding both `inr` and `INR`
 * groups them separately - so the calculator adds them rather than assuming one row each.
 */
export interface SettlementRevenueRow {
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  bookingFeeMinor: number;
  paymentFeeMinor: number;
  organizerFeeMinor: number;
}

/**
 * One completed refund, in the currency of the booking it returns.
 *
 * A refund has no currency of its own, so the caller carries the booking's.
 */
export interface SettlementRefundRow {
  currency: string;
  amountMinor: number;
  /** The portion of `amountMinor` that is tax being returned. */
  taxAddedMinor: number | null;
}

export interface CurrencySettlementInput {
  revenue: readonly SettlementRevenueRow[];
  refunds: readonly SettlementRefundRow[];
}

/**
 * The organizer's share of one refund.
 *
 * ── WHOSE MONEY A REFUND RETURNS ───────────────────────────────────────────────────
 * The ledger used to deduct the WHOLE refund from the organizer. A refund returns the ticket
 * money - which was the organizer's revenue - plus any tax that was ADDED on top of the price,
 * which the platform collected and kept to remit. Charging that tax back to the organizer takes
 * money they never received.
 *
 * Zero for an inclusive-tax market like India, where tax sits inside the ticket price and the
 * whole refund really is the organizer's. That is why the old sum was right there and wrong
 * everywhere the platform adds tax on top.
 *
 * Clamped at zero: a refund recorded as more tax than money is a data fault, and letting it go
 * negative would quietly ADD to the organizer's proceeds.
 *
 * Exported because allocations have to attribute this SAME share to the individual booking a
 * refund returns. A second copy of the clamp would be a second rounding rule, and the allocation
 * sum would stop matching the payout it is supposed to explain.
 */
export function organizerShareOfRefund(row: SettlementRefundRow): number {
  return Math.max(0, row.amountMinor - (row.taxAddedMinor ?? 0));
}

/**
 * One currency's settlement per currency present, sorted by currency code.
 *
 * `net = gross − discount − organizerFee − refund`.
 *
 * `bookingFee` and `paymentFee` are REPORTED and not deducted, and that is correct rather than an
 * oversight: `subtotalMinor` is the ticket face value net to the organizer, and those two are
 * borne by the customer on top of it. The fee an organizer actually bears is `organizerFeeMinor`,
 * which is deducted - the split is decided when the booking is written, so this sum needs no
 * knowledge of `FeeMode`.
 *
 * `net` is NOT clamped at zero, and that is deliberate too. A period whose refunds exceed its
 * sales owes money back, and the payout ledger records it whatever its size, because a clawback
 * nobody recorded is a clawback nobody collects. (`computeMarketplaceSplit` DOES clamp, because
 * it answers a different question: one booking's proceeds, which cannot be negative.)
 */
export function calculateCurrencySettlement(input: CurrencySettlementInput): CurrencySettlement[] {
  const refundByCurrency = new Map<string, number>();
  for (const row of input.refunds) {
    const currency = row.currency.toUpperCase();
    refundByCurrency.set(
      currency,
      (refundByCurrency.get(currency) ?? 0) + organizerShareOfRefund(row),
    );
  }

  // A currency with refunds and no revenue still settles - that is the clawback case.
  const currencies = new Set([
    ...input.revenue.map((row) => row.currency.toUpperCase()),
    ...refundByCurrency.keys(),
  ]);

  return [...currencies].sort().map((currency) => {
    const rows = input.revenue.filter((row) => row.currency.toUpperCase() === currency);
    const sum = (key: keyof Omit<SettlementRevenueRow, 'currency'>): number =>
      rows.reduce((total, row) => total + (row[key] ?? 0), 0);

    const gross = sum('subtotalMinor');
    const discount = sum('discountMinor');
    const organizerFee = sum('organizerFeeMinor');
    const refund = refundByCurrency.get(currency) ?? 0;

    return {
      currency,
      gross,
      discount,
      bookingFee: sum('bookingFeeMinor'),
      paymentFee: sum('paymentFeeMinor'),
      organizerFee,
      refund,
      net: gross - discount - organizerFee - refund,
    };
  });
}
