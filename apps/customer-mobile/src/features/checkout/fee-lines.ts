import type { FeeBreakdown } from './schema';

export interface FeeLine {
  label: string;
  minor: number;
}

/**
 * The lines between "Tickets" and "Total", from the server's breakdown.
 *
 * Owner rule (2026-09-12): the payment processing fee is its OWN line, never inside
 * "Convenience fees". It is the card or UPI network's charge; under a platform heading it
 * reads as money ETicketsGo keeps. The two are split only when they add up to what the
 * buyer pays. When the organizer absorbs part of them, one total line is the only figure
 * that does not mislead.
 */
export function feeLines(fees: FeeBreakdown): FeeLine[] {
  const lines: FeeLine[] = [];
  if (fees.discountMinor > 0) lines.push({ label: 'Discount', minor: -fees.discountMinor });

  if (fees.customerFeeMinor > 0) {
    if (fees.bookingFeeMinor + fees.paymentFeeMinor === fees.customerFeeMinor) {
      if (fees.bookingFeeMinor > 0) {
        lines.push({ label: 'Convenience fees', minor: fees.bookingFeeMinor });
      }
      if (fees.paymentFeeMinor > 0) {
        lines.push({ label: 'Payment processing fee', minor: fees.paymentFeeMinor });
      }
    } else {
      lines.push({ label: 'Fees', minor: fees.customerFeeMinor });
    }
  }

  if ((fees.taxMinor ?? 0) > 0) lines.push({ label: 'Tax', minor: fees.taxMinor ?? 0 });
  return lines;
}
