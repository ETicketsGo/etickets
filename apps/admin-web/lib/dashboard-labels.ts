/**
 * What each count on the platform overview says it counts.
 *
 * Reported by the design audit: "39 failed payments in the last 7 days" sat above a "Payment
 * failures 35" tile. Neither number was wrong. The first counts every market over the last seven
 * days; the second counted one market (INR) since the platform began. The tile and the table said
 * neither, so the page contradicted itself. A count now carries its window and its scope in its
 * label, and these two helpers are the only place those words are written.
 */

/** The "Needs you" indicator: every market, a week. See `failedPaymentsQueue`. */
export const FAILED_PAYMENTS_WEEK_SCOPE = 'all markets';

/** The per-market tile and table column: one currency, since the platform began. */
export function failedPaymentsAllTimeLabel(currency: string | undefined): string {
  return currency ? `Payment failures, ${currency}, all time` : 'Payment failures, all time';
}

/** Bookings are a count, not money, but a market's count must still name its market. */
export function bookingsLabel(currency: string | undefined): string {
  return currency ? `Bookings in ${currency}` : 'Bookings, all markets';
}
