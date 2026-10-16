/**
 * What cancelling an event does to money, in figures, for the organizer to read BEFORE they
 * confirm and again after.
 *
 * The cancel dialog used to say only "every paid booking gets a refund" and "give cash back at
 * the counter". An organizer with forty cash sales learned how much cash they owed only after
 * it was too late to choose a different date, and never got a list of whom to pay.
 *
 * Pure, so the rules are tested without a database. The split mirrors what the cancellation
 * actually does, booking by booking:
 *   - online and paid, with no refund yet: a refund request opens for the full amount
 *     (`openForCancelledSession` returns everything paid on a cancellation);
 *   - online and paid, with a refund already: left with that refund, as the sweep leaves it;
 *   - free: the tickets are cancelled, nothing to pay back;
 *   - cash that was taken: the booking is voided and the cash is owed back at the counter.
 */

/** An amount in one currency. Money in two currencies is never added together. */
export interface CurrencyTotal {
  currency: string;
  amountMinor: number;
}

export interface CancelImpactBooking {
  paymentMethod: string;
  totalMinor: number;
  currency: string;
  cashCollectedAt: Date | null;
  refundCount: number;
}

export interface CancelImpact {
  /** Dates still to come, which the cancellation cancels. */
  datesToCancel: number;
  /** Online bookings a full refund request opens for. */
  onlineRefunds: { count: number; totals: CurrencyTotal[] };
  /** Online bookings that already have a refund; it stands as it is. */
  alreadyInRefund: number;
  /** Free bookings: cancelled, nothing to give back. */
  free: number;
  /** Cash bookings whose money was taken: voided, and the cash is handed back. */
  cash: { count: number; totals: CurrencyTotal[] };
}

/** Sums by currency, largest first, so the headline currency leads. */
export function totalsByCurrency(rows: { currency: string; amountMinor: number }[]) {
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.currency, (by.get(r.currency) ?? 0) + r.amountMinor);
  return [...by.entries()]
    .map(([currency, amountMinor]) => ({ currency, amountMinor }))
    .sort((a, b) => b.amountMinor - a.amountMinor || a.currency.localeCompare(b.currency));
}

export function cancelImpact(datesToCancel: number, bookings: CancelImpactBooking[]): CancelImpact {
  const online = bookings.filter(
    (b) => b.paymentMethod !== 'CASH' && b.totalMinor > 0 && b.refundCount === 0,
  );
  const cash = bookings.filter(
    (b) => b.paymentMethod === 'CASH' && b.cashCollectedAt !== null && b.totalMinor > 0,
  );
  return {
    datesToCancel,
    onlineRefunds: {
      count: online.length,
      totals: totalsByCurrency(
        online.map((b) => ({ currency: b.currency, amountMinor: b.totalMinor })),
      ),
    },
    alreadyInRefund: bookings.filter(
      (b) => b.paymentMethod !== 'CASH' && b.totalMinor > 0 && b.refundCount > 0,
    ).length,
    free: bookings.filter((b) => b.totalMinor === 0).length,
    cash: {
      count: cash.length,
      totals: totalsByCurrency(
        cash.map((b) => ({ currency: b.currency, amountMinor: b.totalMinor })),
      ),
    },
  };
}
