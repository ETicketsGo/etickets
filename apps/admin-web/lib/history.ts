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
};

const PROBLEMS = new Set(['REFUND_FAILED', 'REFUND_FAILED_AT_PROVIDER', 'REFUND_TICKETS_NOT_LIVE']);

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
  const reason = text(m.reason) ?? text(m.note);
  if (reason) details.push(`Reason: ${reason}`);
  const via = text(m.via);
  if (via && VIA[via]) details.push(`Asked ${VIA[via]}`);
  const providerRef = text(m.providerRef);
  if (providerRef) details.push(`Provider reference ${providerRef}`);
  return {
    when: entry.createdAt,
    text: SENTENCES[entry.action] ?? plainWords(entry.action),
    who: entry.actor ? entry.actor.fullName || entry.actor.email : 'System',
    detail: details.length ? details.join('. ') : null,
    problem: PROBLEMS.has(entry.action),
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
export function failedRefundAdvice(entries: HistoryEntry[]): {
  cause: string;
  steps: string[];
} {
  const actions = new Set(entries.map((e) => e.action));
  // The worst case first: the customer has lost their tickets and has not had their money.
  if (actions.has('REFUND_FAILED_AT_PROVIDER')) {
    return {
      cause:
        'The payment provider accepted it and later reported that it failed. The tickets were cancelled when it was accepted, so the customer has neither their tickets nor their money.',
      steps: [
        "Look the refund up in the provider's dashboard with the provider reference below to see why it failed.",
        'Pay the customer back by hand from the provider dashboard. This console cannot retry it.',
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
        'Tell the customer it did not go through. They can ask again once the cause is fixed.',
      ],
    };
  }
  return {
    cause:
      'The call to the payment provider did not finish, and no reason was recorded. Assume no money moved until the provider says otherwise.',
    steps: [
      "Look the payment up in the provider's dashboard with the payment reference below: if a refund is there, it did go through.",
      'If there is no refund there, tell the customer it did not go through. They can ask again.',
    ],
  };
}
