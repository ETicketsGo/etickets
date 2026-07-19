/**
 * Deterministic, explainable fraud/risk signals (v2.0 WS8). Advisory ONLY — never
 * cancels bookings, suspends accounts or blocks payments. Computed from aggregate
 * platform data (counts/rates), not raw customer rows, and every signal carries its
 * supporting evidence. Identifiers passed in should already be masked by the caller.
 */

export type RiskSeverity = 'low' | 'medium' | 'high';

export interface RiskSignal {
  key: string;
  severity: RiskSeverity;
  title: string;
  /** The metric that triggered the signal. */
  evidence: string;
  /** Advisory next step for a human reviewer. */
  recommendation: string;
}

export interface RiskSignalInput {
  windowLabel: string;
  /** Highest number of bookings attributed to a single (masked) buyer in the window. */
  topBuyerBookings?: { label: string; count: number };
  /** Payment failure counts in the window. */
  paymentFailures?: { failed: number; total: number };
  /** Refund pressure in the window. */
  refunds?: { refundedMinor: number; grossMinor: number; count: number };
  /** Coupons at/over their redemption cap, or with unusually high usage. */
  coupons?: { code: string; redemptions: number; maxRedemptions: number | null }[];
  /** Highest ticket-transfer count by a single (masked) actor. */
  topTransferrer?: { label: string; transfers: number };
}

const THRESHOLDS = {
  bookingVelocity: 10, // bookings by one buyer in the window
  paymentFailureRate: 0.4, // fraction of attempts failing
  paymentFailureMin: 10, // minimum attempts to consider a rate
  refundRate: 0.15, // fraction of gross refunded
  refundCountMin: 5,
  transferVelocity: 10, // transfers by one actor
};

export function deriveRiskSignals(input: RiskSignalInput): RiskSignal[] {
  const signals: RiskSignal[] = [];

  // Unusual booking velocity.
  if (input.topBuyerBookings && input.topBuyerBookings.count >= THRESHOLDS.bookingVelocity) {
    const c = input.topBuyerBookings.count;
    signals.push({
      key: 'BOOKING_VELOCITY',
      severity: c >= THRESHOLDS.bookingVelocity * 2 ? 'high' : 'medium',
      title: 'Unusual booking velocity',
      evidence: `${input.topBuyerBookings.label} made ${c} bookings (${input.windowLabel}).`,
      recommendation: 'Review these orders for reseller or automated activity.',
    });
  }

  // Repeated payment failures.
  if (
    input.paymentFailures &&
    input.paymentFailures.total >= THRESHOLDS.paymentFailureMin &&
    input.paymentFailures.failed / input.paymentFailures.total >= THRESHOLDS.paymentFailureRate
  ) {
    const rate = Math.round((input.paymentFailures.failed / input.paymentFailures.total) * 100);
    signals.push({
      key: 'PAYMENT_FAILURES',
      severity: rate >= 60 ? 'high' : 'medium',
      title: 'Elevated payment failures',
      evidence: `${input.paymentFailures.failed}/${input.paymentFailures.total} attempts failed (${rate}%, ${input.windowLabel}).`,
      recommendation: 'Check the provider status and possible card-testing activity.',
    });
  }

  // Excessive refund activity.
  if (
    input.refunds &&
    input.refunds.count >= THRESHOLDS.refundCountMin &&
    input.refunds.grossMinor > 0 &&
    input.refunds.refundedMinor / input.refunds.grossMinor >= THRESHOLDS.refundRate
  ) {
    const rate = Math.round((input.refunds.refundedMinor / input.refunds.grossMinor) * 100);
    signals.push({
      key: 'EXCESSIVE_REFUNDS',
      severity: rate >= 30 ? 'high' : 'medium',
      title: 'Excessive refund activity',
      evidence: `${input.refunds.count} refunds, ${rate}% of gross (${input.windowLabel}).`,
      recommendation: 'Investigate event or fulfilment issues driving refunds.',
    });
  }

  // Coupon abuse patterns.
  for (const c of input.coupons ?? []) {
    const overCap = c.maxRedemptions !== null && c.redemptions >= c.maxRedemptions;
    if (overCap || c.redemptions >= 100) {
      signals.push({
        key: 'COUPON_ABUSE',
        severity: overCap ? 'medium' : 'low',
        title: 'Coupon usage anomaly',
        evidence: `Coupon ${c.code}: ${c.redemptions}${
          c.maxRedemptions !== null ? `/${c.maxRedemptions}` : ''
        } redemptions.`,
        recommendation: 'Confirm the coupon is being used as intended.',
      });
    }
  }

  // High-volume ticket transfers.
  if (input.topTransferrer && input.topTransferrer.transfers >= THRESHOLDS.transferVelocity) {
    signals.push({
      key: 'TRANSFER_VELOCITY',
      severity:
        input.topTransferrer.transfers >= THRESHOLDS.transferVelocity * 2 ? 'high' : 'medium',
      title: 'High-volume ticket transfers',
      evidence: `${input.topTransferrer.label} initiated ${input.topTransferrer.transfers} transfers (${input.windowLabel}).`,
      recommendation: 'Review for unauthorised resale of tickets.',
    });
  }

  return signals;
}
