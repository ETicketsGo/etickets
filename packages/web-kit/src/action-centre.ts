/**
 * What needs a person in the back office, and where it is done.
 *
 * ── THE PROBLEM THIS SOLVES ────────────────────────────────────────────────────────
 * The admin console opens on ten figures: gross merchandise value, platform revenue,
 * bookings, refund volume, repeat-customer rate. Every one of them measures the platform and
 * not one of them says what to do. An operator starting their shift had to open Organizers,
 * Events, Refunds, Payouts, Settlements, Finance Recon and Support in turn to find out
 * whether anything was waiting - seven pages to answer "is there work", and the answer was
 * usually no, so the habit of checking decays and then something sits for a week.
 *
 * A queue nobody is told about is a queue nobody works. So this is the list: the states that
 * need a human decision, each with the consequence of leaving it, and a link that lands on
 * the work rather than on the page that contains the work.
 *
 * ── ORDERED BY WHAT DELAY COSTS, NOT BY SIZE ───────────────────────────────────────
 * A queue of forty complaints is not more urgent than one chargeback due tomorrow. Sorting by
 * count would put the cheap, large queue first every time. So the order here is fixed and
 * editorial, from "a deadline passes and the money is gone" down to "somebody is waiting for
 * an answer", and a count never reorders it.
 *
 * ── EVERY QUEUE NAMES ITS CAPABILITY ───────────────────────────────────────────────
 * Back-office authority is a set of named capabilities, not a role (see `AdminPermission`).
 * The console asks only for the queues the signed-in operator may see, which is both why
 * there are no refusals in the network tab and why a moderator is not shown money they
 * cannot act on. It is not the enforcement - every route keeps its own guard - it is what
 * stops the page offering work that is not this person's.
 */

/** A capability name, as `AdminPermission` defines it. Kept as a string here so this file
 *  stays free of a dependency the API owns. */
export type AdminCapability = string;

export interface ActionQueue {
  key: string;
  /** What is waiting, as a noun an operator would use. Filled in with the count. */
  label: (count: number) => string;
  /** What happens if it is left. One sentence, plain, and never a threat. */
  consequence: string;
  /** Where the work is done. Carries the filter, so the link lands ON the queue. */
  href: string;
  /** The capability without which this queue is not this person's business. */
  needs: AdminCapability;
  /** How loudly it reads when it is not empty. */
  tone: 'critical' | 'warning' | 'normal';
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The queues, most costly to leave first.
 *
 * Deliberately NOT here:
 *
 * - **Merchant onboarding** and **environment promotion**. Real work, but a platform setup
 *   task somebody schedules, not a queue that fills up while nobody looks.
 * - **Failed jobs and queue depth**. Already on Operations, which is where an engineer looks;
 *   this page is for the business queues, and mixing the two means neither is scanned.
 * - **Events a moderator already rejected**, and refunds already decided. A finished decision
 *   is not work. Every filter below names a state that is still waiting on us.
 */
export const ACTION_QUEUES: ActionQueue[] = [
  {
    key: 'disputes',
    label: (n) => plural(n, 'chargeback to answer', 'chargebacks to answer'),
    consequence:
      'The provider sets the deadline. Miss it and the chargeback is lost by default, with nothing to appeal to.',
    href: '/admin/disputes',
    needs: 'FINANCE_READ',
    tone: 'critical',
  },
  {
    key: 'refunds-requested',
    label: (n) => plural(n, 'refund awaiting a decision', 'refunds awaiting a decision'),
    consequence: 'A customer has asked for their money back and has not been told either way.',
    href: '/admin/refunds?status=REQUESTED',
    needs: 'REFUND_REVIEW',
    tone: 'warning',
  },
  {
    key: 'refunds-failed',
    label: (n) => plural(n, 'refund that did not go through', 'refunds that did not go through'),
    consequence:
      'The refund was approved and the money did not move. The customer is expecting it.',
    href: '/admin/refunds?status=FAILED',
    needs: 'REFUND_REVIEW',
    tone: 'critical',
  },
  {
    key: 'payouts-failed',
    label: (n) => plural(n, 'payout that failed', 'payouts that failed'),
    consequence: 'An organizer has not been paid for tickets that were sold.',
    href: '/admin/payouts',
    needs: 'PAYOUT_MANAGE',
    tone: 'critical',
  },
  {
    key: 'settlements-blocked',
    label: (n) => plural(n, 'settlement blocked', 'settlements blocked'),
    /*
      BLOCKED and not also FAILED, deliberately. A settlement fails when a provider transfer
      fails, and provider transfer execution is held off by a standing release gate - so a
      FAILED settlement cannot presently occur, and a queue that can never fill teaches an
      operator to stop reading the page. Add it when transfers are switched on.
    */
    consequence:
      'Money is held back from an organizer by a review, and stays held until somebody decides.',
    href: '/admin/settlements?status=BLOCKED',
    needs: 'FINANCE_READ',
    tone: 'warning',
  },
  {
    key: 'organizers-pending',
    label: (n) =>
      plural(n, 'organizer waiting to be approved', 'organizers waiting to be approved'),
    consequence: 'They have applied and cannot sell anything until somebody looks.',
    href: '/admin/organizers?status=PENDING',
    needs: 'ORGANIZER_REVIEW',
    tone: 'normal',
  },
  {
    key: 'events-review',
    label: (n) => plural(n, 'event waiting for review', 'events waiting for review'),
    consequence: 'The organizer has finished it and cannot put it on sale until it is approved.',
    href: '/admin/events?status=UNDER_REVIEW',
    needs: 'EVENT_REVIEW',
    tone: 'normal',
  },
  {
    key: 'complaints-open',
    label: (n) => plural(n, 'open complaint', 'open complaints'),
    consequence: 'A customer says an organizer wronged them and nobody has replied.',
    href: '/admin/support?kind=COMPLAINT&status=OPEN',
    needs: 'BOOKING_READ',
    tone: 'warning',
  },
];

/**
 * The queues this operator may see, in the fixed order above.
 *
 * An unknown or absent capability list yields nothing rather than everything. A console that
 * guesses "probably allowed" when it has not been told produces a page full of refusals, and
 * on the landing page that reads as the product being broken.
 */
export function queuesFor(capabilities: readonly string[] | undefined): ActionQueue[] {
  if (!capabilities || capabilities.length === 0) return [];
  const held = new Set(capabilities);
  return ACTION_QUEUES.filter((q) => held.has(q.needs));
}
