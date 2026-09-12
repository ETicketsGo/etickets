/**
 * What a member may do in an organization, read from their role in it.
 *
 * ── WHY THE CONSOLE NEEDS THIS AT ALL ──────────────────────────────────────────────
 * The API has always enforced these rules; the console never knew them. So a manager was
 * offered Refund, check-in staff were offered Invite, and each found out from an error after
 * pressing the button. The rules here mirror the API's role checks only so the console can
 * stop offering what will be refused. They grant nothing — every request is still checked.
 *
 * ── WHY A MISSING ROLE MEANS UNRESTRICTED ─────────────────────────────────────────
 * `null` is a platform administrator, whom the API lets through every organization check.
 * `undefined` is an API that does not send the role yet. Hiding owner actions in either case
 * would take buttons away from people the API would let use them, which is the worse failure:
 * an offered action the API refuses explains itself, a missing one does not.
 */
export interface OrgPermissions {
  /** Owner-only acts: deciding refunds, changing the team, cash at the venue, legal details. */
  ownerActions: boolean;
  /** Payouts and settlement figures: owners and managers, never check-in staff. */
  financials: boolean;
}

export function orgPermissions(role: string | null | undefined): OrgPermissions {
  if (role == null) return { ownerActions: true, financials: true };
  return {
    ownerActions: role === 'ORGANIZER_OWNER',
    financials: role === 'ORGANIZER_OWNER' || role === 'ORGANIZER_MANAGER',
  };
}

/** Whether a failed request was refused for lack of permission, as opposed to failing. */
export function isForbidden(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 403
  );
}
