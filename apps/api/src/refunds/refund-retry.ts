/**
 * Whether a FAILED refund may be sent to the payment provider again, and how.
 *
 * ── WHY THIS IS ITS OWN, PURE FUNCTION ─────────────────────────────────────────────
 * A retry is the one refund action that can pay a customer twice. Everything that decides it
 * is gathered first (by `RefundsService.retryFacts`) and judged here with no database and no
 * clock, so every rule below is exercised by a unit test rather than trusted.
 *
 * ── THE TWO QUESTIONS ──────────────────────────────────────────────────────────────
 * 1. Did the provider definitely NOT pay this refund? A provider that answered "failed" or
 *    "refused" has told us so. A call that threw - a timeout, a dropped connection - has not:
 *    the provider may have paid and the answer been lost on the way back. Sending that one
 *    again is exactly how a double refund happens, so it needs a person who has looked the
 *    payment up in the provider's own dashboard to say there is no refund there.
 * 2. Are the tickets still held? A refund that failed BEFORE the provider accepted it never
 *    returned its tickets, and its retry is the whole refund again - tickets, credit note,
 *    customer notice - through the same code as an approval. One that the provider accepted
 *    and failed LATER (Razorpay's `refund.failed`) has already returned its tickets and issued
 *    its credit note; its retry is only the provider leg, or the tickets would be voided twice.
 *
 * And, whatever the answers, never more back than was paid, and never while the provider
 * reports a refund on this payment that no row here accounts for - that unaccounted refund may
 * be this one.
 *
 * ── ASK THE PROVIDER FIRST ─────────────────────────────────────────────────────────
 * Question 1 used to be answered only by the admin ticking "I checked the dashboard". The
 * provider is now asked directly for the payment's refunds (`refund-reconcile.ts`):
 *   FOUND        it holds a refund made with this refund's key - record it, send nothing.
 *   NONE         it answered and shows no such refund - sending again (same key) is safe,
 *                once the lost call is old enough to have finished there (else TOO_SOON).
 *   UNMATCHED    it shows a refund that may be this one but cannot be matched - refuse.
 *   UNAVAILABLE  it could not be asked - only then is the admin's confirmation needed.
 */

/** What the latest attempt at this refund told us about the money. */
export type LastAnswer = 'REFUSED' | 'UNKNOWN';

/** How far the refund got before it failed. */
export type RetryStage = 'TICKETS_HELD' | 'TICKETS_RETURNED';

export type RetryRefusal =
  | 'NOT_FAILED'
  | 'BOOKING_MISSING'
  | 'CASH'
  | 'NO_PAYMENT'
  | 'TICKETS_GONE'
  | 'NEEDS_CONFIRMATION'
  | 'UNMATCHED_PROVIDER_REFUND'
  | 'OVER_PAYMENT'
  | 'TOO_SOON';

/** One audit entry about this refund, oldest first. */
export interface RefundHistoryEntry {
  action: string;
  metadata?: Record<string, unknown> | null;
}

export interface RetryFacts {
  status: string;
  amountMinor: number;
  history: RefundHistoryEntry[];
  /** A credit note exists for this refund: it went through the step that returns tickets. */
  hasCreditNote: boolean;
  /** Every ticket the refund names is still ACTIVE or CHECKED_IN. */
  ticketsLive: boolean;
  bookingExists: boolean;
  paidInCash: boolean;
  /** The captured payment, or null when there is none (a free booking). */
  payment: { amountMinor: number; refundedMinor: number } | null;
  /** The booking's OTHER refunds. */
  otherRefunds: { status: string; amountMinor: number }[];
  /** Refunds the provider has reported on this payment that no refund row here accounts for. */
  unmatchedProviderRefunds: number;
  /** The admin confirmed they checked the provider dashboard and found no refund for this. */
  confirmedNoProviderRefund: boolean;
  /**
   * What the provider's own list of this payment's refunds said, or null when it was not asked
   * (cash, a free booking, no payment reference). Optional so older callers stay valid.
   */
  providerLookup?: ProviderLookupFact | null;
  /** Why the refund is held for a person, when it is (see `Refund.manualReviewReason`). */
  manualReviewReason?: string | null;
  /**
   * Set when the provider showed no refund but the last call whose answer was lost is too recent
   * for that to be believed: the call may still be in flight there (`RECHECK_AFTER_MS`). The
   * time from which an empty lookup counts. Computed by the caller, which has the clock.
   */
  noneBelievableAfter?: Date | null;
}

export interface ProviderLookupFact {
  kind: 'FOUND' | 'REFUSED' | 'NONE' | 'UNMATCHED' | 'UNAVAILABLE';
  providerRef?: string;
  status?: 'COMPLETED' | 'PROCESSING' | 'FAILED';
  amountMinor?: number;
  reason?: string;
}

/** What an allowed retry does: send the money, or record a refund the provider already made. */
export type RetryAction = 'SEND' | 'RECORD_PROVIDER_REFUND';

export interface RetryAssessment {
  allowed: boolean;
  stage: RetryStage | null;
  lastAnswer: LastAnswer;
  refusal: RetryRefusal | null;
  /** True when the only thing missing is the admin's confirmation (see LastAnswer UNKNOWN). */
  needsConfirmation: boolean;
  /** One plain sentence: what a retry would do, or why it cannot be done. */
  message: string;
  /** What an allowed retry would do; null when it is not allowed. */
  action: RetryAction | null;
  /** What the provider said when it was asked; echoed so the console can show it. */
  providerLookup: ProviderLookupFact | null;
  /** Set when the refund is held for a person, with the reason. */
  manualReviewReason: string | null;
}

/** Audit actions that mean the provider ACCEPTED this refund at some point. */
const ACCEPTED = new Set(['REFUND_PROCESSING', 'REFUND_COMPLETED', 'REFUND_FAILED_AT_PROVIDER']);

/**
 * What the newest attempt established, read from the history in order.
 *
 * Starts at UNKNOWN: a refund whose first provider call threw has no failure entry at all. A
 * retry writes REFUND_RETRY_STARTED in the same transaction that claims it, before any money
 * call, so a retry whose outcome was never recorded (a crash, a lost answer) reads UNKNOWN
 * too. Missing records only ever make this stricter.
 */
export function lastAnswerOf(history: RefundHistoryEntry[]): LastAnswer {
  let answer: LastAnswer = 'UNKNOWN';
  for (const e of history) {
    if (e.action === 'REFUND_FAILED' || e.action === 'REFUND_FAILED_AT_PROVIDER') {
      answer = 'REFUSED';
    } else if (e.action === 'REFUND_RETRY_STARTED') {
      answer = 'UNKNOWN';
    } else if (e.action === 'REFUND_RETRY_RESULT') {
      answer = e.metadata?.outcome === 'FAILED' ? 'REFUSED' : 'UNKNOWN';
    }
  }
  return answer;
}

/** Every provider refund reference this refund has carried, so their webhooks are not "unmatched". */
export function providerRefsOf(history: RefundHistoryEntry[], current: string | null): string[] {
  const refs = new Set<string>();
  if (current) refs.add(current);
  for (const e of history) {
    for (const key of ['providerRef', 'previousProviderRef', 'providerRefundId']) {
      const v = e.metadata?.[key];
      if (typeof v === 'string' && v) refs.add(v);
    }
  }
  return [...refs];
}

export function assessRetry(f: RetryFacts): RetryAssessment {
  const lastAnswer = lastAnswerOf(f.history);
  const lookup = f.providerLookup ?? null;
  const echo = { providerLookup: lookup, manualReviewReason: f.manualReviewReason ?? null };
  const refuse = (
    refusal: RetryRefusal,
    message: string,
    stage: RetryStage | null = null,
  ): RetryAssessment => ({
    allowed: false,
    stage,
    lastAnswer,
    refusal,
    needsConfirmation: false,
    message,
    action: null,
    ...echo,
  });

  if (f.status !== 'FAILED') {
    return refuse('NOT_FAILED', 'Only a refund that did not go through can be tried again.');
  }
  if (!f.bookingExists) {
    return refuse('BOOKING_MISSING', 'The booking for this refund no longer exists.');
  }
  if (f.paidInCash && f.amountMinor > 0) {
    return refuse(
      'CASH',
      'This booking was paid in cash at the venue. Cash refunds are handled at the venue, not online.',
    );
  }
  if (!f.payment && f.amountMinor > 0) {
    return refuse(
      'NO_PAYMENT',
      'No payment is recorded for this booking, so there is nothing to send the refund back to.',
    );
  }

  const accepted = f.hasCreditNote || f.history.some((e) => ACCEPTED.has(e.action));
  const stage: RetryStage = accepted ? 'TICKETS_RETURNED' : 'TICKETS_HELD';
  if (
    !accepted &&
    (!f.ticketsLive || f.history.some((e) => e.action === 'REFUND_TICKETS_NOT_LIVE'))
  ) {
    return refuse(
      'TICKETS_GONE',
      'Its tickets already went back through another refund or a cancellation. The customer is not owed this amount twice.',
    );
  }

  if (lookup?.kind === 'UNMATCHED') {
    return refuse(
      'UNMATCHED_PROVIDER_REFUND',
      `${lookup.reason ?? 'The payment provider shows a refund on this payment that cannot be matched to this one.'} Check the provider dashboard before doing anything else.`,
      stage,
    );
  }
  const found = lookup?.kind === 'FOUND';
  if (f.unmatchedProviderRefunds > 0) {
    return refuse(
      'UNMATCHED_PROVIDER_REFUND',
      'The payment provider reports a refund on this payment that no refund here accounts for. It may be this one. Check the provider dashboard before doing anything else.',
      stage,
    );
  }
  if (f.payment) {
    // Settled refunds the provider has reported. More than ours means one we do not know about.
    // A refund the provider's lookup matched to this one is accounted for by this row.
    const ourSettled =
      f.otherRefunds
        .filter((r) => r.status === 'COMPLETED')
        .reduce((sum, r) => sum + r.amountMinor, 0) + (found ? (lookup?.amountMinor ?? 0) : 0);
    if (f.payment.refundedMinor > ourSettled) {
      return refuse(
        'UNMATCHED_PROVIDER_REFUND',
        'The payment provider reports more refunded on this payment than the refunds here add up to. The difference may be this refund. Check the provider dashboard before doing anything else.',
        stage,
      );
    }
    const committed = f.otherRefunds
      .filter((r) => r.status === 'COMPLETED' || r.status === 'PROCESSING')
      .reduce((sum, r) => sum + r.amountMinor, 0);
    if (committed + f.amountMinor > f.payment.amountMinor) {
      return refuse(
        'OVER_PAYMENT',
        'Sending this would return more than the customer paid, counting the refunds already made on this booking.',
        stage,
      );
    }
  }

  if (found) {
    return {
      allowed: true,
      stage,
      lastAnswer,
      refusal: null,
      needsConfirmation: false,
      action: 'RECORD_PROVIDER_REFUND',
      ...echo,
      message:
        stage === 'TICKETS_RETURNED'
          ? 'The payment provider already has this refund. Trying again records it here. No money is sent again.'
          : 'The payment provider already has this refund. Trying again records it here, cancels the tickets and tells the customer. No money is sent again.',
    };
  }

  /*
    The provider shows no refund, but the call whose answer was lost may still be in flight
    there, where it is not listed yet. Sending now could be the second refund, so no confirmation
    unlocks it: the dashboard cannot show an unfinished refund either.
  */
  if (lookup?.kind === 'NONE' && f.noneBelievableAfter) {
    return refuse(
      'TOO_SOON',
      `The last call to the payment provider did not come back with an answer, and it may still be in progress there. The provider does not list a refund yet, but that is not proof until ${f.noneBelievableAfter.toISOString().slice(0, 16).replace('T', ' ')} UTC. Check again after that.`,
      stage,
    );
  }

  // The provider answered the lookup: it shows no refund (or refused this key). Safe to send.
  const providerSaysNone = lookup?.kind === 'NONE' || lookup?.kind === 'REFUSED';
  if (lastAnswer === 'UNKNOWN' && !providerSaysNone && !f.confirmedNoProviderRefund) {
    return {
      allowed: false,
      stage,
      lastAnswer,
      refusal: 'NEEDS_CONFIRMATION',
      needsConfirmation: true,
      action: null,
      ...echo,
      message:
        (f.manualReviewReason ? 'This refund needs a manual check. ' : '') +
        'The last call to the payment provider did not come back with an answer, and the provider could not be asked whether it made the refund, so the money may have moved. Look the payment up in the provider dashboard first. Try again only if there is no refund there.',
    };
  }

  const sameKey =
    lastAnswer === 'UNKNOWN' && providerSaysNone
      ? ' The last call did not come back with an answer, but the provider shows no refund for it. It is sent once more, with the same key.'
      : '';
  return {
    allowed: true,
    stage,
    lastAnswer,
    refusal: null,
    needsConfirmation: false,
    action: 'SEND',
    ...echo,
    message:
      (stage === 'TICKETS_RETURNED'
        ? 'The tickets were already cancelled when the provider first accepted this refund. Trying again only asks the provider to pay it.'
        : 'Trying again sends the refund to the provider. If it is paid, the tickets are cancelled and the customer is told.') +
      sameKey,
  };
}
