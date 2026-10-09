import type { ActionQueue } from '@eticketsgo/web-kit';

/**
 * What the admin dashboard leads with: the queues that need a person, and the indicators that
 * do not.
 *
 * ── TWO KINDS OF NUMBER, KEPT APART ────────────────────────────────────────────────
 * A refund request is work: somebody has to decide it, and until they do a customer is waiting.
 * A failed payment is usually not: a card was declined and the buyer can try again, and nobody on
 * the platform can do anything about it - though a sudden run of them can mean a provider is
 * down. Shown in one list with one colour, the second kind teaches an operator that the list is
 * noise, and then the first kind is missed. So every queue says which it is:
 *
 *   - `action`  - a state that waits on us. Counted, coloured by what delay costs, and the only
 *                 kind that can make the page say "N things need you".
 *   - `info`    - worth knowing, never a task. Shown in a separate, neutral strip.
 *
 * ── WHERE THE QUEUES COME FROM ─────────────────────────────────────────────────────
 * The shared list in web-kit (`ACTION_QUEUES`) is the platform's definition of "waiting on a
 * decision", and the organizer-facing code does not need to know about the admin-only additions
 * here, so this file takes that list as an argument and adds two of its own:
 *
 *   - reconciliation exceptions nobody has picked up (OPEN, not ASSIGNED), because the
 *     reconciliation console has had no way in from the dashboard at all;
 *   - failed payments in the last seven days, as INFORMATION - see above.
 *
 * Nothing here invents a figure. Every count is the total of the list its link opens, read by
 * the component from the existing endpoint for that list.
 */

export type QueueKind = 'action' | 'info';

export interface AttentionQueue extends ActionQueue {
  kind: QueueKind;
}

export type QueueOutcome =
  { status: 'loading' } | { status: 'error' } | { status: 'ok'; count: number; note?: string };

export interface AttentionItem {
  queue: AttentionQueue;
  outcome: QueueOutcome;
}

export interface AttentionSummary {
  /** Action queues with something in them, in the fixed order of what delay costs. */
  needsAction: AttentionItem[];
  /** Action queues that answered and are empty. */
  clear: AttentionItem[];
  /** Action queues that could not be counted. Never reported as empty. */
  unchecked: AttentionItem[];
  /** Action queues still being counted. */
  loading: AttentionItem[];
  /** Informational indicators, whatever their state. */
  info: AttentionItem[];
  /** How many items wait across the action queues that answered. */
  waiting: number;
  /** True only once every action queue has answered: the one state that may say "nothing". */
  allChecked: boolean;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** `YYYY-MM-DD` of a date in UTC, the shape the admin list filters take. */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The seven UTC days ending today, inclusive - the window the failed-payments indicator counts
 * and the payments list it links to is filtered by. One definition, so the number on the
 * dashboard and the list under the link cannot cover different weeks.
 */
export function lastSevenDays(now: Date): { from: string; to: string } {
  const from = new Date(now.getTime());
  from.setUTCDate(from.getUTCDate() - 6);
  return { from: utcDay(from), to: utcDay(now) };
}

export const RECONCILIATION_QUEUE: AttentionQueue = {
  key: 'reconciliation-open',
  kind: 'action',
  label: (n) =>
    plural(
      n,
      'reconciliation exception nobody has picked up',
      'reconciliation exceptions nobody has picked up',
    ),
  consequence:
    'The provider and our records disagree about money, and nobody is assigned to find out why.',
  href: '/admin/finance-reconciliation?status=OPEN',
  needs: 'FINANCE_READ',
  tone: 'warning',
};

export function failedPaymentsQueue(now: Date): AttentionQueue {
  const { from, to } = lastSevenDays(now);
  return {
    key: 'payments-failed-7d',
    kind: 'info',
    label: (n) =>
      plural(n, 'failed payment in the last 7 days', 'failed payments in the last 7 days'),
    consequence:
      'Usually a declined card, and the buyer can try again. Nothing to do unless it is a sudden spike.',
    href: `/admin/payments?status=FAILED&from=${from}&to=${to}`,
    needs: 'BOOKING_READ',
    tone: 'normal',
  };
}

/**
 * The queues this operator may see: the shared ones (already filtered by capability, as
 * `queuesFor` returns them) as action queues, the reconciliation queue after the blocked
 * settlements it sits beside, and the informational indicators last.
 *
 * An absent or empty capability list yields nothing, as `queuesFor` does: a console that guesses
 * "probably allowed" fills the landing page with refusals.
 */
export function attentionQueues(
  shared: readonly ActionQueue[],
  capabilities: readonly string[] | undefined,
  now: Date,
): AttentionQueue[] {
  if (!capabilities || capabilities.length === 0) return [];
  const held = new Set(capabilities);
  const out: AttentionQueue[] = [];
  for (const q of shared) {
    if (!held.has(q.needs)) continue;
    out.push({ ...q, kind: 'action' });
    if (q.key === 'settlements-blocked' && held.has(RECONCILIATION_QUEUE.needs)) {
      out.push(RECONCILIATION_QUEUE);
    }
  }
  // Placed even when the shared list stops carrying settlements, rather than silently dropped.
  if (
    held.has(RECONCILIATION_QUEUE.needs) &&
    !out.some((q) => q.key === RECONCILIATION_QUEUE.key)
  ) {
    out.push(RECONCILIATION_QUEUE);
  }
  const failed = failedPaymentsQueue(now);
  if (held.has(failed.needs)) out.push(failed);
  return out;
}

/** Sorts each queue's outcome into what the dashboard shows where. */
export function summarise(items: AttentionItem[]): AttentionSummary {
  const s: AttentionSummary = {
    needsAction: [],
    clear: [],
    unchecked: [],
    loading: [],
    info: [],
    waiting: 0,
    allChecked: false,
  };
  for (const item of items) {
    if (item.queue.kind === 'info') {
      s.info.push(item);
      continue;
    }
    const o = item.outcome;
    if (o.status === 'loading') s.loading.push(item);
    else if (o.status === 'error') s.unchecked.push(item);
    else if (o.count > 0) {
      s.needsAction.push(item);
      s.waiting += o.count;
    } else s.clear.push(item);
  }
  const actionCount = items.filter((i) => i.queue.kind === 'action').length;
  s.allChecked = actionCount > 0 && s.loading.length === 0 && s.unchecked.length === 0;
  return s;
}

/** What a queue is called with no number in front of it, for "could not check ..." lines. */
export function queueNoun(queue: ActionQueue): string {
  // Built from the plural label with a count of 2, so "refunds awaiting a decision" rather than
  // the singular, then the number taken off the front.
  return queue.label(2).replace(/^2 /, '');
}
