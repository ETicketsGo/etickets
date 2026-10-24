/**
 * Each back-office duty: a name a person would use, and what holding it lets them do.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────
 * The staff screen listed duties as their codes in sentence case - "Ops execute", "Finance
 * resolve", "Bank verify", "Platform config" - and explained two of the nineteen. Somebody granting
 * access could not tell what they were handing over without reading the API (walked on QA,
 * 2026-10-15). The words below follow the definitions in `@eticketsgo/shared-types`
 * (`admin-permissions.ts`), which is what each duty actually unlocks.
 *
 * A duty this file does not know yet still reads as words, so a new one is never blank.
 */
export const DUTY_WORDS: Record<string, { label: string; what: string }> = {
  BOOKING_READ: {
    label: 'See bookings',
    what: 'Any booking, its tickets and its payment. The floor for support.',
  },
  ORGANIZER_READ: {
    label: 'See organizers',
    what: 'Organizations, their events and their status.',
  },
  FINANCE_READ: {
    label: 'See money',
    what: 'Revenue, settlements, payouts, reconciliation and business reports.',
  },
  OPS_READ: {
    label: 'See operations',
    what: 'Job queues, outbox, sync health and other system internals.',
  },
  AUDIT_READ: {
    label: 'See the audit log',
    what: 'Search the record of who did what, and the history on a booking or refund.',
  },
  OPS_EXECUTE: {
    label: 'Re-run background work',
    what: 'Retry or replay failed jobs and events. Side effects run again.',
  },
  FINANCE_APPROVE: {
    label: 'Approve compensations',
    what: 'Approve, retry or release a booking compensation so it executes.',
  },
  FINANCE_RESOLVE: {
    label: 'Close money findings',
    what: 'Run discrepancy checks and resolve or ignore a finding. Moves no money.',
  },
  SUPPORT_MANAGE: {
    label: 'Handle support messages',
    what: 'Change the status of a support message or complaint.',
  },
  REFUND_REVIEW: {
    label: 'Review refunds',
    what: 'See the refund queue and turn a refund down. Cannot pay one.',
  },
  REFUND_APPROVE: {
    label: 'Approve refunds',
    what: 'Moves money, and it does not come back. Reviewing a refund is a separate duty.',
  },
  ORGANIZER_REVIEW: {
    label: 'Approve organizers',
    what: 'Approve, reject, suspend or reinstate an organization.',
  },
  EVENT_REVIEW: {
    label: 'Approve events',
    what: 'Approve or reject a submitted event, and pause or cancel a live one.',
  },
  PLATFORM_CONFIG_READ: {
    label: 'See fees and tax rules',
    what: 'Read booking fees, tax rules and cinema pricing. Changes nothing.',
  },
  PLATFORM_CONFIG: {
    label: 'Change fees and tax rules',
    what: 'Change booking fees, tax rules, cinema pricing and maintenance mode. Affects every sale.',
  },
  PAYOUT_MANAGE: {
    label: 'Manage payouts',
    what: 'Open payouts and settlements, see masked bank accounts, edit terms, hold a settlement.',
  },
  BANK_VERIFY: {
    label: 'Check bank accounts',
    what: 'Mark an organizer bank account checked or turn it down. Needs Manage payouts too.',
  },
  PAYOUT_EXECUTE: {
    label: 'Pay organizers',
    what: 'Mark a payout paid or failed and release a settlement. Never for an account you checked.',
  },
  PAYMENT_ADMIN: {
    label: 'Change payment setup',
    what: 'Payment provider configuration, merchant onboarding and outage state.',
  },
  ADMIN_MANAGE: {
    label: 'Manage staff',
    what: 'Add staff and give them any duty, so it is the most powerful one. Cannot change your own duties.',
  },
  USER_SUSPEND: {
    label: 'Suspend accounts',
    what: 'Suspend or reinstate any account, and sign it out on every device.',
  },
  CRM_AGENT: {
    label: 'Acquisition agent',
    what: 'Organizer Acquisition only: add prospects, work the leads assigned to you in your team, log outreach and keep follow-ups. Opens nothing else.',
  },
  CRM_MANAGER: {
    label: 'Acquisition manager',
    what: 'With Acquisition agent: every lead in the teams you manage, assign work, link prospects to organizer accounts, import, export and reports. Opens nothing else.',
  },
};

/** "REFUND_APPROVE" -> its name; an unknown duty as plain words. */
export function dutyLabel(permission: string): string {
  return (
    DUTY_WORDS[permission]?.label ??
    permission.charAt(0) + permission.slice(1).toLowerCase().replace(/_/g, ' ')
  );
}

export function dutyWhat(permission: string): string | null {
  return DUTY_WORDS[permission]?.what ?? null;
}
