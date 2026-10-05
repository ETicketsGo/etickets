import { BookingStatus } from '@eticketsgo/shared-types';

export interface RefundEligibilityInput {
  bookingStatus: BookingStatus;
  sessionStartsAt: Date;
  now: Date;
  /** Whether this event offers refunds at all. Set by the organizer, not the platform. */
  refundsEnabled?: boolean;
  /** Cut-off window before the session start, in hours. Comes from the event. */
  policyHours?: number;
  /**
   * Whether the SHOW was cancelled, rather than the buyer changing their mind.
   *
   * ── WHY THIS OVERRIDES THE ORGANIZER'S OWN RULES ───────────────────────────────
   * Both rules below exist to protect the organizer from a buyer who waited too long or
   * bought a non-refundable ticket. Neither is about a show that is not happening.
   *
   * Applying them to a cancellation produces the worst answer this module can give: the
   * organizer calls off the show, and the person who paid is told refunds closed 48 hours
   * ago, or that this event does not offer them. They are not asking for a favour - they
   * are owed the money for a thing they will not receive.
   *
   * The booking status check still applies. An already-refunded booking is not refunded
   * twice because the show was then cancelled.
   */
  sessionCancelled?: boolean;
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
  /*
    A cancelled show skips the organizer's own two rules, and only those. See
    `sessionCancelled` above for why: they protect an organizer from a late or ineligible
    buyer, and neither describes a show that is not happening.
  */
  if (input.sessionCancelled) return { eligible: true };

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
