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

/** The part of `refundRetryCheck` these helpers read. */
interface LookupFact {
  kind: string;
  providerRef?: string;
  reason?: string;
}

// The API's own preamble on an UNAVAILABLE reason; the sentence below already says it.
const COULD_NOT_ASK = /^The payment provider could not be asked whether it made this refund:\s*/;

/**
 * What the provider said when it was asked for this payment's refunds, as one sentence.
 *
 * UNAVAILABLE used to be one fixed sentence whatever the API found, so a reason that said
 * "nothing was paid on it, do not send this refund" was never shown and the page told the admin
 * to try again. The API's reason is now part of the sentence. NOT_PAID is its own case: the
 * provider WAS asked, and holds no payment at all.
 */
export function lookupSentence(lookup: LookupFact | null, provider: string): string | null {
  const who = provider || 'The payment provider';
  switch (lookup?.kind) {
    case 'FOUND':
      return `${who} was asked: it has this refund (${lookup.providerRef ?? 'no reference given'}).`;
    case 'REFUSED':
      return `${who} was asked: it has this refund, and it refused it.`;
    case 'NONE':
      return `${who} was asked: it shows no refund for this payment.`;
    case 'UNMATCHED':
      return `${who} was asked: it shows a refund on this payment that cannot be matched to this one.`;
    case 'NOT_PAID':
      return `${who} was asked: nothing was paid on this order, so there is nothing to refund.`;
    case 'UNAVAILABLE': {
      const said = (lookup.reason ?? '').replace(COULD_NOT_ASK, '').trim();
      return `${who} could not be asked whether it made this refund.${said ? ` What it said: ${said}` : ''}`;
    }
    default:
      return null;
  }
}

/**
 * Whether "Try the refund again" is offered. Only when the API allows it, or allows it once the
 * admin confirms the dashboard. Never for NOT_PAID: no tick can make a payment exist, and the
 * API refuses it anyway.
 */
export function showRetryButton(
  a: { allowed: boolean; needsConfirmation: boolean; refusal: string | null } | undefined | null,
): boolean {
  if (!a || a.refusal === 'NOT_PAID') return false;
  return a.allowed || a.needsConfirmation;
}
