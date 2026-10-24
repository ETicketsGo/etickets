/**
 * What a back-office account is allowed to do.
 *
 * ── WHY PERMISSIONS AND NOT MORE ROLES ─────────────────────────────────────────────
 * Until now there was one `ADMIN` role and every admin route accepted it, so anybody who
 * could open the console could do everything on it — including approve a refund, change
 * platform fee rules, and read every booking on the platform. That is fine with two
 * trusted people and untenable with ten.
 *
 * The obvious fix is more roles — "support", "finance", "moderator" — and it is the wrong
 * one. Roles accrete powers: the moment support needs to see settlements, either the role
 * grows or a second role is invented, and within a year nobody can answer "what can this
 * person actually do" without reading code.
 *
 * So the unit of authorization is a NAMED CAPABILITY. Roles still exist, as bundles that
 * make onboarding quick, but they are only shorthand for a set of these — the guard never
 * checks a role, and a bundle can be edited without touching a route.
 *
 * ── THE DISTINCTION THAT MOTIVATED THIS ────────────────────────────────────────────
 * `REFUND_REVIEW` and `REFUND_APPROVE` are deliberately separate. Reviewing a request —
 * reading it, checking the booking, marking it as looked at — moves no money. Approving one
 * does, irreversibly. A role-based model cannot express "may investigate, may not pay out"
 * without inventing a role per combination; two named capabilities express it exactly.
 */
export const AdminPermission = {
  // ── Reading ────────────────────────────────────────────────────────────────────
  /** See any booking, its tickets and its payment. The floor for a support desk. */
  BOOKING_READ: 'BOOKING_READ',
  /** See organizations, their events and their status. */
  ORGANIZER_READ: 'ORGANIZER_READ',
  /** See revenue, settlements, payouts and reconciliation. */
  FINANCE_READ: 'FINANCE_READ',
  /** See queue depth, outbox, sync health and other operational internals. */
  OPS_READ: 'OPS_READ',
  /**
   * Search the platform audit log and read a record's history.
   *
   * It used to ride on BOOKING_READ, the support desk's floor. But the log is not a booking: it
   * names who granted which duty, who revealed a bank number, who signed in from where and who
   * approved which refund. A support desk that can read that can map who holds power and when
   * they act, which is the thing separation of duties exists to keep from one pair of hands.
   */
  AUDIT_READ: 'AUDIT_READ',

  // ── Acting on what the reads show, split from them on purpose ──────────────────
  /*
    Each of these used to ride on the READ capability of its page, because the handlers sat on a
    controller whose class guard was the read. "May see the outbox" then also meant "may replay
    every dead-lettered event", and "may see revenue" meant "may approve a compensation". Like
    PLATFORM_CONFIG_READ / PLATFORM_CONFIG, neither half implies the other: somebody who acts on
    a queue is granted the read as well, on purpose, by whoever holds ADMIN_MANAGE.
  */
  /**
   * Retry or replay failed background jobs, retry / cancel / park outbox events and recover their
   * leases, and reprocess, retry, reconcile, re-map or reset the checkpoint of an inventory sync.
   * Each re-runs work that already ran once - side effects included.
   */
  OPS_EXECUTE: 'OPS_EXECUTE',
  /**
   * Approve, retry or release the lease of a booking compensation, which lets it execute.
   * Seeing compensations is FINANCE_READ.
   */
  FINANCE_APPROVE: 'FINANCE_APPROVE',
  /**
   * Work the finance exception queues: run discrepancy detection, assign, resolve or ignore a
   * discrepancy, and park a compensation for manual review. Closes a money finding without
   * moving money; the decision is audited.
   */
  FINANCE_RESOLVE: 'FINANCE_RESOLVE',
  /** Change the status of a support submission or complaint. Seeing them is BOOKING_READ. */
  SUPPORT_MANAGE: 'SUPPORT_MANAGE',

  // ── Refunds, split on purpose ──────────────────────────────────────────────────
  /** See the refund queue and record a decision that does NOT move money. */
  REFUND_REVIEW: 'REFUND_REVIEW',
  /** Approve a refund. Money leaves the platform and does not come back. */
  REFUND_APPROVE: 'REFUND_APPROVE',

  // ── Moderation ─────────────────────────────────────────────────────────────────
  /** Approve or reject an organization's application to sell. */
  ORGANIZER_REVIEW: 'ORGANIZER_REVIEW',
  /** Approve or reject a submitted event. */
  EVENT_REVIEW: 'EVENT_REVIEW',

  // ── Money and configuration ────────────────────────────────────────────────────
  /**
   * See platform fee rules, tax rules and cinema pricing policies. Changes nothing.
   *
   * Separate from `PLATFORM_CONFIG` so somebody who has to explain a charge (finance, an
   * auditor) can read the rules without being able to change them. Neither implies the other:
   * an editor is granted both, on purpose, by whoever holds `ADMIN_MANAGE`.
   */
  PLATFORM_CONFIG_READ: 'PLATFORM_CONFIG_READ',
  /**
   * Change platform fee rules, tax rules, cinema pricing policies and maintenance mode.
   * Affects every sale.
   */
  PLATFORM_CONFIG: 'PLATFORM_CONFIG',
  /** Open the payout and settlement pages, see masked accounts, edit terms, block a settlement. */
  PAYOUT_MANAGE: 'PAYOUT_MANAGE',
  /*
    Separation of duties on payouts. PAYOUT_MANAGE alone no longer verifies an account or moves
    money:
      BANK_VERIFY     - verify or reject an organizer's bank account (Finance A).
      PAYOUT_EXECUTE  - mark a payout paid or failed, approve and release a settlement (Finance B).
    A write needs PAYOUT_MANAGE AND its own capability (all-of). Whoever verified an account can
    never pay into it, whatever they hold, super admin included - see `markPaid`.
  */
  BANK_VERIFY: 'BANK_VERIFY',
  PAYOUT_EXECUTE: 'PAYOUT_EXECUTE',
  /** Change payment provider configuration, onboarding and outage state. */
  PAYMENT_ADMIN: 'PAYMENT_ADMIN',

  // ── The platform's own staff ───────────────────────────────────────────────────
  /**
   * Create back-office accounts and change what they may do.
   *
   * Held by the super admin and, in practice, nobody else — an account that can grant
   * itself a capability effectively holds all of them, so this is the one grant that
   * cannot be delegated casually.
   */
  ADMIN_MANAGE: 'ADMIN_MANAGE',
  /**
   * Suspend or reinstate any account, and sign it out everywhere (revoke every refresh token).
   *
   * Split from ADMIN_MANAGE because stopping an abusive customer is a support decision, not a
   * question of who works in the back office. It is still granted person by person, in no
   * bundle: an account that can lock others out can lock out the people who would stop it.
   * Nobody may suspend themselves, and only a super admin may suspend a super admin.
   */
  USER_SUSPEND: 'USER_SUSPEND',

  // ── Organizer acquisition (sales CRM) ──────────────────────────────────────────
  /*
    The acquisition desk works PROSPECTS - organizations the platform would like to sell for -
    and never the platform's customers, bookings or money. Neither capability opens a single
    route outside /admin/crm, and what each holder sees inside it is narrowed again by their
    CRM team (country) membership, read from the database on every request.
  */
  /**
   * Work organizer prospects: add a lead, edit and move the leads ASSIGNED TO YOU in your
   * team, log outreach you did (logged, never sent) and keep your own follow-ups. Sees no
   * other agent's leads and no other country's.
   */
  CRM_AGENT: 'CRM_AGENT',
  /**
   * Lead an acquisition team: every lead in the teams you manage, assign and reassign them,
   * reopen lost leads, link a prospect to an existing organization, import and export leads,
   * and read the team's reports. Always granted together with CRM_AGENT.
   */
  CRM_MANAGER: 'CRM_MANAGER',
} as const;

export type AdminPermission = (typeof AdminPermission)[keyof typeof AdminPermission];

export const ALL_ADMIN_PERMISSIONS = Object.values(AdminPermission) as AdminPermission[];

/**
 * Ready-made bundles, so a new starter is useful in one click rather than twelve.
 *
 * The contents are the owner's decision, approved 2026-10-10 and recorded in
 * docs/security/ADMIN-PERMISSION-MATRIX.md; `admin-presets.spec.ts` holds them to it exactly.
 * In short: FINANCE carries the finance actions split out of FINANCE_READ (FINANCE_APPROVE,
 * FINANCE_RESOLVE) and may READ the fee and tax rules so it can explain a charge; SUPPORT may
 * change a support message's status (SUPPORT_MANAGE); the refund desk does not; OPERATIONS
 * reads and re-runs background work. No bundle carries `PLATFORM_CONFIG`: who may change what
 * the platform charges is decided per person by whoever grants it.
 *
 * These are a convenience at ASSIGNMENT time only. Once granted, the account holds the
 * individual capabilities — so editing a bundle later never silently changes what an
 * existing person can do, which is the trap with roles that are evaluated at request time.
 */
export const ADMIN_PRESETS: Record<
  string,
  { label: string; description: string; grants: AdminPermission[] }
> = {
  SUPPORT: {
    label: 'Support',
    description:
      'Can find any booking and see what happened to it, and mark a support message or complaint open, triaged or closed. Cannot change a booking, a refund or any money.',
    grants: [
      AdminPermission.BOOKING_READ,
      AdminPermission.ORGANIZER_READ,
      AdminPermission.SUPPORT_MANAGE,
    ],
  },
  REFUND_DESK: {
    label: 'Refund desk',
    description:
      'Reviews refund requests and records findings. Cannot approve one — the money needs a second pair of hands.',
    grants: [
      AdminPermission.BOOKING_READ,
      AdminPermission.ORGANIZER_READ,
      AdminPermission.REFUND_REVIEW,
    ],
  },
  FINANCE: {
    label: 'Finance',
    description:
      'Sees the money and the fee and tax rules, approves refunds and compensations, works the discrepancy queue and releases settlements. Cannot change the fee or tax rules.',
    grants: [
      AdminPermission.BOOKING_READ,
      AdminPermission.FINANCE_READ,
      AdminPermission.REFUND_REVIEW,
      AdminPermission.REFUND_APPROVE,
      AdminPermission.PAYOUT_MANAGE,
      AdminPermission.FINANCE_APPROVE,
      AdminPermission.FINANCE_RESOLVE,
      AdminPermission.PLATFORM_CONFIG_READ,
    ],
  },
  MODERATOR: {
    label: 'Moderation',
    description: 'Reviews organizer applications and submitted events.',
    grants: [
      AdminPermission.ORGANIZER_READ,
      AdminPermission.ORGANIZER_REVIEW,
      AdminPermission.EVENT_REVIEW,
    ],
  },
  OPERATIONS: {
    label: 'Operations',
    description:
      'Watches the job queues, the outbox and inventory sync, and retries or replays work that failed. Cannot open bookings or payments, and moves no money.',
    grants: [AdminPermission.OPS_READ, AdminPermission.OPS_EXECUTE],
  },
  /*
    The four duties below split the money path between people. They are granted to nobody until
    the owner names the people. A person holds ONE of FINANCE_VERIFIER / FINANCE_PAYER: the
    server refuses a payment into an account the same person verified even if both are held.
  */
  FINANCE_VERIFIER: {
    label: 'Finance A (bank verifier)',
    description:
      'Checks and verifies or rejects organizer bank accounts. Cannot pay a payout or release a settlement, and can never pay into an account they verified.',
    grants: [
      AdminPermission.BOOKING_READ,
      AdminPermission.FINANCE_READ,
      AdminPermission.PAYOUT_MANAGE,
      AdminPermission.BANK_VERIFY,
    ],
  },
  FINANCE_PAYER: {
    label: 'Finance B (payer)',
    description:
      'Marks payouts paid or failed and releases settlements. Cannot verify a bank account. Payouts to an account that is not verified by someone else are refused.',
    grants: [
      AdminPermission.BOOKING_READ,
      AdminPermission.FINANCE_READ,
      AdminPermission.PAYOUT_MANAGE,
      AdminPermission.PAYOUT_EXECUTE,
    ],
  },
  FINANCE_REVIEWER: {
    label: 'Finance reviewer',
    description:
      'Reads revenue, the audit log and finance reports for independent oversight. Cannot see bank accounts and cannot move money.',
    /*
      AUDIT_READ: the description has always promised "the audit log", and since the log left
      BOOKING_READ this is the one bundle whose job is independent oversight. No other bundle
      carries it - a desk that does the work is not the desk that reviews the record of it.
    */
    grants: [
      AdminPermission.BOOKING_READ,
      AdminPermission.FINANCE_READ,
      AdminPermission.AUDIT_READ,
    ],
  },
  OPS_ONCALL: {
    label: 'On-call operations',
    description:
      'Watches queues, the outbox and inventory sync and retries failed work during an incident. Cannot move money and cannot see bank data.',
    grants: [AdminPermission.OPS_READ, AdminPermission.OPS_EXECUTE],
  },
  /*
    The acquisition desk. Deliberately NOTHING else: no booking, organizer, finance or audit
    read. An intern contacting prospects must not be able to open a customer's booking or an
    organizer's bank details, and the CRM routes are the only ones these grants open.
  */
  CRM_AGENT: {
    label: 'Acquisition agent',
    description:
      'Adds organizer prospects, works the leads assigned to them in their team, logs outreach and keeps follow-ups. Cannot see bookings, customers, payouts or settings.',
    grants: [AdminPermission.CRM_AGENT],
  },
  CRM_MANAGER: {
    label: 'Acquisition manager',
    description:
      'Runs an acquisition team: sees every lead in the teams they manage, assigns work, links prospects to existing organizations, imports and exports leads and reads the reports. Cannot see bookings, customers, payouts or settings.',
    grants: [AdminPermission.CRM_AGENT, AdminPermission.CRM_MANAGER],
  },
};

/**
 * A super admin holds everything, implicitly and permanently.
 *
 * Not by being granted every capability — a grant can be revoked, and an installation whose
 * last super admin has had `ADMIN_MANAGE` removed is one nobody can repair. The role is
 * checked directly instead, so the recovery path cannot be locked away.
 */
export function permissionsFor(
  roles: readonly string[],
  grants: readonly AdminPermission[],
): Set<AdminPermission> {
  if (roles.includes('SUPER_ADMIN')) return new Set(ALL_ADMIN_PERMISSIONS);
  return new Set(grants);
}
