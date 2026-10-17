import type { RefundRetryResult } from '@eticketsgo/web-kit';

/**
 * What the payment provider answered when a failed refund was tried again, as one sentence.
 *
 * Display only: the API decided, this says it. ERROR is the case that matters most to word
 * carefully - a call that never answered may still have paid, so it must never read as "failed,
 * try again".
 */
export function retryOutcomeText(r: Pick<RefundRetryResult, 'outcome' | 'recorded'>): string {
  // The provider already had it: recorded here, and nothing was sent a second time.
  if (r.recorded && (r.outcome === 'COMPLETED' || r.outcome === 'PROCESSING')) {
    return r.outcome === 'COMPLETED'
      ? 'The provider had already paid this refund. It is now recorded here. No money was sent again.'
      : 'The provider had already accepted this refund and is paying it. It is now recorded here. No money was sent again.';
  }
  switch (r.outcome) {
    case 'COMPLETED':
      return 'The provider paid the refund back.';
    case 'PROCESSING':
      return 'The provider accepted the refund and is paying it. It becomes Refunded when the provider confirms it.';
    case 'FAILED':
      return 'The provider refused it, or shows no refund for it. No money moved.';
    case 'NEEDS_REVIEW':
      return 'The provider did not answer, and asking it did not show whether it made the refund. The money may or may not have moved. It needs a manual check in the provider dashboard.';
    default:
      return 'The provider did not answer, so the money may or may not have moved. Check the provider dashboard before trying again.';
  }
}

/** Whether the provider took the refund (paid, or accepted and paying). */
export function retrySucceeded(r: Pick<RefundRetryResult, 'outcome'>): boolean {
  return r.outcome === 'COMPLETED' || r.outcome === 'PROCESSING';
}
