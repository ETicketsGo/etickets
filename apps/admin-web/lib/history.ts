import { plainWords } from './words';

/**
 * One record's audit entries as sentences a support person can read out.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────
 * "An admin finds a customer's booking and sees what happened" ended, on QA, on a page that held
 * the booking's current state and nothing about how it got there: not when it was paid, not who
 * asked for the refund, not why a refund failed. All of that was already in the audit log, under
 * the booking's and the refund's ids, and nothing on either page read it. A failed refund said
 * "This refund is failed." - and the reason the provider gave sat one table away.
 *
 * Display only. The words describe recorded actions; they never decide anything.
 */
export interface HistoryEntry {
  action: string;
  createdAt: string;
  actor: { email: string; fullName: string } | null;
  metadata?: Record<string, unknown> | null;
}

export interface HistoryLine {
  when: string;
  /** What happened, in a sentence. */
  text: string;
  /** Who did it, or "System" for the platform itself. */
  who: string;
  /** Something the action recorded that a person needs (a reason, a provider reference). */
  detail: string | null;
  /** True for an entry that went wrong, so the page can colour it. */
  problem: boolean;
}

const SENTENCES: Record<string, string> = {
  CINEMA_LEGAL_TYPE_CHANGED: 'Legal type changed',
  BOOKING_CREATED: 'Booking started',
  BOOKING_CONFIRMED: 'Paid and confirmed. Tickets issued',
  BOOKING_CANCELLED: 'Booking cancelled',
  BOOKING_TICKETS_PRINTED: 'Tickets printed',
  FREE_TICKETS_CANCELLED: 'Free tickets cancelled',
  REFUND_REQUESTED: 'Refund asked for',
  REFUND_PROCESSING: 'Refund approved and sent to the payment provider',
  REFUND_COMPLETED: 'Refund paid back',
  REFUND_REJECTED: 'Refund turned down',
  REFUND_FAILED: 'The payment provider refused the refund. No tickets were cancelled',
  REFUND_FAILED_AT_PROVIDER:
    'The payment provider accepted the refund, then reported it failed. The tickets were already cancelled',
  REFUND_TICKETS_NOT_LIVE:
    'Refund stopped: some of its tickets had already been refunded or cancelled. Nothing was paid out',
  REFUND_RETRY_STARTED: 'Sent to the payment provider again',
  REFUND_RETRY_REFUSED: 'Try again was refused, so nothing was sent',
  REFUND_PROVIDER_LOOKUP:
    'The payment provider did not answer, so it was asked for the refunds it holds',
  REFUND_NEEDS_MANUAL_REVIEW:
    'Held for a manual check: the provider could not confirm whether it made this refund',
};

/** What the provider's list of the payment's refunds showed, for REFUND_PROVIDER_LOOKUP. */
const LOOKUP_RESULT: Record<string, string> = {
  FOUND: 'The provider has this refund',
  REFUSED: 'The provider has this refund, refused',
  NONE: 'The provider shows no refund for it',
  UNMATCHED: 'The provider shows a refund that cannot be matched to this one',
  NOT_PAID: 'The provider holds no payment for it: nothing was paid, so nothing can be refunded',
  UNAVAILABLE: 'The provider could not be asked',
};

/** A retry's result, by what the provider answered. */
const RETRY_RESULT: Record<string, string> = {
  COMPLETED: 'Tried again: the refund was paid back',
  PROCESSING: 'Tried again: the provider accepted it and is paying it',
  FAILED: 'Tried again: the payment provider refused it',
  NEEDS_REVIEW:
    'Tried again: the payment provider did not answer, and asking it did not settle it. It needs a manual check',
  ERROR: 'Tried again: the payment provider did not answer, so it may or may not have paid',
};

const PROBLEMS = new Set([
  'REFUND_FAILED',
  'REFUND_FAILED_AT_PROVIDER',
  'REFUND_TICKETS_NOT_LIVE',
  'REFUND_RETRY_REFUSED',
  'REFUND_NEEDS_MANUAL_REVIEW',
]);

/** Where a request came from, for REFUND_REQUESTED's `via`. */
const VIA: Record<string, string> = {
  ACCOUNT: 'from their account',
  GUEST: 'from the emailed link',
  ORGANIZER: 'by the organizer',
  ADMIN: 'by the platform team',
};

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function historyLine(entry: HistoryEntry): HistoryLine {
  const m = entry.metadata ?? {};
  const details: string[] = [];
  // A before -> after an action wrote in words (a cinema's legal type), read out as written.
  const change = text(m.change);
  if (change) details.push(change);
  // What the provider's lookup showed comes before the reason it gives.
  const lookup = entry.action === 'REFUND_PROVIDER_LOOKUP' ? text(m.result) : null;
  if (lookup && LOOKUP_RESULT[lookup]) details.push(LOOKUP_RESULT[lookup]);
  const reason = text(m.reason) ?? text(m.note);
  if (reason) details.push(`Reason: ${reason}`);
  const via = text(m.via);
  if (via && VIA[via]) details.push(`Asked ${VIA[via]}`);
  const providerRef = text(m.providerRef);
  if (providerRef) details.push(`Provider reference ${providerRef}`);
  if (entry.action === 'REFUND_RETRY_STARTED' && m.confirmedNoProviderRefund === true)
    details.push('Checked the provider dashboard first: no refund there');
  const message = entry.action === 'REFUND_RETRY_RESULT' ? text(m.message) : null;
  if (message) details.push(`Provider said: ${message}`);
  const outcome = entry.action === 'REFUND_RETRY_RESULT' ? text(m.outcome) : null;
  return {
    when: entry.createdAt,
    text: (outcome && RETRY_RESULT[outcome]) ?? SENTENCES[entry.action] ?? plainWords(entry.action),
    who: entry.actor ? entry.actor.fullName || entry.actor.email : 'System',
    detail: details.length ? details.join('. ') : null,
    problem:
      PROBLEMS.has(entry.action) ||
      outcome === 'FAILED' ||
      outcome === 'ERROR' ||
      outcome === 'NEEDS_REVIEW',
  };
}

/*
  Access checks, not events. Opening a booking in this console records that an admin read it
  (PLATFORM_ORGANIZER_ACCESS_*), so the history of every booking filled up with "access allowed"
  lines - one more each time somebody looked. Who read what stays in the audit log itself.
*/
const NOT_HISTORY = /^PLATFORM_ORGANIZER_ACCESS_/;

/** Oldest first: a history is read in the order it happened. */
export function historyLines(entries: HistoryEntry[]): HistoryLine[] {
  return entries
    .filter((e) => !NOT_HISTORY.test(e.action))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(historyLine);
}

/**
 * What to do about a refund that did not go through, from what its history says went wrong.
 *
 * A FAILED refund is a dead end in the console: nothing can approve it again. So the page says
 * what the failure means for the customer and who has to act, rather than "This refund is failed."
 */
export function failedRefundAdvice(
  entries: HistoryEntry[],
  // Set when the refund is held for a manual check (`Refund.manualReviewReason`).
  manualReviewReason?: string | null,
  // What the provider said when the retry check asked it (`providerLookup.kind`), if it has.
  lookupKind?: string | null,
): {
  cause: string;
  steps: string[];
} {
  const actions = new Set(entries.map((e) => e.action));
  /*
    The provider was asked and holds no payment at all. Every other branch below ends in "try
    the refund again"; here there is no money to send, and what is wrong is the booking: it was
    confirmed without being paid (QA's mock-settled ETG-IND-2026-000013/14/15).
  */
  if (lookupKind === 'NOT_PAID') {
    return {
      cause:
        'Nothing was paid on this order at the payment provider, so there is nothing to refund. No money moved.',
      steps: [
        'Open the booking and check how it was confirmed. A booking confirmed without a payment was never paid.',
        'If it is test data, cancel the booking as unpaid. Do not refund it.',
        'Do not try the refund again, and do not send money from the provider dashboard.',
      ],
    };
  }
  /*
    The case nothing automatic may settle: a call lost its answer and the provider could not be
    asked. First, because the money may already be with the customer.
  */
  if (manualReviewReason) {
    return {
      cause:
        'The payment provider did not answer, and it could not be asked whether it made this refund. The money may already be with the customer. Nothing is sent again automatically.',
      steps: [
        "Look the payment up in the provider's dashboard with the payment reference below.",
        'If a refund is there, do not send it again. Try the refund again asks the provider first, and records that refund once the provider can be asked.',
        'If there is no refund there, use Try the refund again below and confirm what you checked.',
      ],
    };
  }
  // The worst case first: the customer has lost their tickets and has not had their money.
  if (actions.has('REFUND_FAILED_AT_PROVIDER')) {
    return {
      cause:
        'The payment provider accepted it and later reported that it failed. The tickets were cancelled when it was accepted, so the customer has neither their tickets nor their money.',
      steps: [
        "Look the refund up in the provider's dashboard with the provider reference below to see why it failed.",
        'Once the cause is fixed, use Try the refund again below. Only the money is sent again; the tickets stay cancelled.',
        'Tell the customer what happened and when to expect the money.',
      ],
    };
  }
  if (actions.has('REFUND_TICKETS_NOT_LIVE')) {
    return {
      cause:
        'Its tickets had already gone back through another refund or a cancellation, so nothing was paid out. The customer is not owed this amount twice.',
      steps: [
        'Open the booking and check the other refund on it was paid.',
        'If it was, tell the customer that refund is the one coming to them.',
      ],
    };
  }
  if (actions.has('REFUND_FAILED')) {
    return {
      cause:
        'The payment provider refused it. No money moved and no tickets were cancelled - the customer still holds their tickets.',
      steps: [
        "Look the payment up in the provider's dashboard with the payment reference below to see why it was refused.",
        'Once the cause is fixed, use Try the refund again below.',
        'Tell the customer what is happening with their money.',
      ],
    };
  }
  return {
    cause:
      'The call to the payment provider did not finish, and no reason was recorded. Assume no money moved until the provider says otherwise.',
    steps: [
      "Look the payment up in the provider's dashboard with the payment reference below: if a refund is there, it did go through. Do not try again.",
      'If there is no refund there, use Try the refund again below and confirm what you checked.',
    ],
  };
}
