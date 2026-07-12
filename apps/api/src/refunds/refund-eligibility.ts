import { BookingStatus } from '@eticketsgo/shared-types';

export interface RefundEligibilityInput {
  bookingStatus: BookingStatus;
  sessionStartsAt: Date;
  now: Date;
  /** Cut-off window before the session start, in hours (default 48). */
  policyHours?: number;
}

export interface RefundEligibility {
  eligible: boolean;
  reason?: string;
}

/**
 * Pure refund eligibility rule. A booking is refundable only while confirmed
 * (or partially refunded) and before the policy cut-off ahead of the session.
 */
export function checkRefundEligibility(input: RefundEligibilityInput): RefundEligibility {
  const refundableStatuses: BookingStatus[] = [
    BookingStatus.CONFIRMED,
    BookingStatus.PARTIALLY_REFUNDED,
  ];
  if (!refundableStatuses.includes(input.bookingStatus)) {
    return { eligible: false, reason: `Booking status ${input.bookingStatus} is not refundable.` };
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
