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
  /** Release settlements and run payouts. */
  PAYOUT_MANAGE: 'PAYOUT_MANAGE',
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
} as const;

export type AdminPermission = (typeof AdminPermission)[keyof typeof AdminPermission];

export const ALL_ADMIN_PERMISSIONS = Object.values(AdminPermission) as AdminPermission[];

/**
 * Ready-made bundles, so a new starter is useful in one click rather than twelve.
 *
 * None of them carries `PLATFORM_CONFIG_READ` or `PLATFORM_CONFIG`: who may see or change
 * what the platform charges is decided per person by whoever grants it, not by a default.
 * Nor `OPS_EXECUTE`, `FINANCE_APPROVE`, `FINANCE_RESOLVE` or `SUPPORT_MANAGE`: those were split
 * out of the reads without granting them to anybody, and which bundle should carry them is the
 * owner's decision (docs/security/ADMIN-PERMISSION-MATRIX.md lists the proposals).
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
      'Can find any booking and see what happened to it. Cannot change or delete anything.',
    grants: [AdminPermission.BOOKING_READ, AdminPermission.ORGANIZER_READ],
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
    description: 'Sees the money, approves refunds and releases settlements.',
    grants: [
      AdminPermission.BOOKING_READ,
      AdminPermission.FINANCE_READ,
      AdminPermission.REFUND_REVIEW,
      AdminPermission.REFUND_APPROVE,
      AdminPermission.PAYOUT_MANAGE,
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
