import { BookingStatus } from '@eticketsgo/shared-types';

export interface RefundEligibilityInput {
  bookingStatus: BookingStatus;
  sessionStartsAt: Date;
  now: Date;
  /** Whether this event offers refunds at all. Set by the organizer, not the platform. */
  refundsEnabled?: boolean;
  /** Cut-off window before the session start, in hours. Comes from the event. */
  policyHours?: number;
}

export interface RefundEligibility {
  eligible: boolean;
  reason?: string;
}

/**
 * Pure refund eligibility rule.
 *
 * ── WHOSE POLICY THIS IS ───────────────────────────────────────────────────────────
 * The organizer's. The cut-off used to be a constant here — 48 hours, for every event on
 * the platform — which meant showing buyers a refund button the organizer had never agreed
 * to honour, and granting requests they would have refused. The money still leaves when
 * that happens, so the platform was underwriting a promise it had no standing to make.
 *
 * Both inputs now come from the event, and the defaults reproduce the old behaviour so an
 * untouched event behaves exactly as it did.
 */
export function checkRefundEligibility(input: RefundEligibilityInput): RefundEligibility {
  const refundableStatuses: BookingStatus[] = [
    BookingStatus.CONFIRMED,
    BookingStatus.PARTIALLY_REFUNDED,
  ];
  if (!refundableStatuses.includes(input.bookingStatus)) {
    return { eligible: false, reason: `Booking status ${input.bookingStatus} is not refundable.` };
  }
  if (input.refundsEnabled === false) {
    return {
      eligible: false,
      reason: 'This organizer does not offer refunds for this event.',
    };
  }
  const policyHours = input.policyHours ?? 48;
  const cutoff = new Date(input.sessionStartsAt.getTime() - policyHours * 60 * 60 * 1000);
  if (input.now >= cutoff) {
    return {
      eligible: false,
      reason: `Refunds close ${policyHours} hours before the session starts.`,
    };
  }
  return { eligible: true };
}
