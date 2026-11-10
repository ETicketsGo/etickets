/**
 * The approved legal identity, and when a change to it must be reviewed.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────
 * The legal identity on an organization is editable by its owner at any time, and payouts
 * used to be judged against it. So an approved company could rename itself to a person and
 * change its legal form to "Individual", and a verified PERSONAL bank account then passed the
 * ownership rule (seen in PROD, 2026-11-10). Payouts are now judged against an APPROVED
 * snapshot that only an independent staff decision writes, and a change to any payout-critical
 * field puts the identity - and the organizer's payouts, nothing else - on hold until then.
 */

/** The fields that decide who is paid, and where. Contacts and address are not among them. */
export const PAYOUT_CRITICAL_FIELDS = [
  'legalName',
  'legalEntityType',
  'registeredCountry',
  'taxRegistrationKind',
  'taxRegistrationNumber',
] as const;
export type PayoutCriticalField = (typeof PAYOUT_CRITICAL_FIELDS)[number];
export type LegalIdentity = Record<PayoutCriticalField, string | null>;

export type LegalIdentityStatusValue =
  'UNREVIEWED' | 'APPROVED' | 'PENDING_REVIEW' | 'CHANGES_REQUESTED';

const norm = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  return t ? t : null;
};

/** The approved snapshot, or null when no identity has ever been approved. */
export function approvedIdentity(org: {
  approvedLegalName: string | null;
  approvedLegalEntityType: string | null;
  approvedRegisteredCountry: string | null;
  approvedTaxRegistrationKind: string | null;
  approvedTaxRegistrationNumber: string | null;
  legalIdentityApprovedAt: Date | string | null;
}): LegalIdentity | null {
  if (!org.legalIdentityApprovedAt) return null;
  return {
    legalName: org.approvedLegalName,
    legalEntityType: org.approvedLegalEntityType,
    registeredCountry: org.approvedRegisteredCountry,
    taxRegistrationKind: org.approvedTaxRegistrationKind,
    taxRegistrationNumber: org.approvedTaxRegistrationNumber,
  };
}

export function currentIdentity(org: Partial<LegalIdentity>): LegalIdentity {
  return {
    legalName: org.legalName ?? null,
    legalEntityType: org.legalEntityType ?? null,
    registeredCountry: org.registeredCountry ?? null,
    taxRegistrationKind: org.taxRegistrationKind ?? null,
    taxRegistrationNumber: org.taxRegistrationNumber ?? null,
  };
}

/** Which payout-critical fields differ from the approved snapshot (all of them when none). */
export function changedCriticalFields(
  approved: LegalIdentity | null,
  next: LegalIdentity,
): PayoutCriticalField[] {
  return PAYOUT_CRITICAL_FIELDS.filter((f) => !approved || norm(approved[f]) !== norm(next[f]));
}

/**
 * The identity status after an edit.
 *
 * Before the organization is approved there is nothing to protect yet: approving the
 * organization approves its identity. After that, any payout-critical difference from the
 * approved snapshot is PENDING_REVIEW; an edit that puts every field back to the approved
 * values is APPROVED again, so a typo corrected and undone does not wait for anybody.
 */
export function identityStatusAfterEdit(input: {
  organizationStatus: string;
  current: LegalIdentityStatusValue;
  approved: LegalIdentity | null;
  next: LegalIdentity;
}): { status: LegalIdentityStatusValue; changed: PayoutCriticalField[] } {
  const live = input.organizationStatus === 'APPROVED' || input.organizationStatus === 'SUSPENDED';
  if (!live) return { status: input.current, changed: [] };
  const changed = changedCriticalFields(input.approved, input.next);
  if (input.approved && changed.length === 0) return { status: 'APPROVED', changed };
  return { status: 'PENDING_REVIEW', changed };
}

/**
 * Whether approving this identity changes whose bank account is correct: a new legal name or
 * a new legal form. When it does, a bank account verified under the old identity must be
 * checked again before it can receive money.
 */
export function ownershipBasisChanged(
  previous: LegalIdentity | null,
  approvedNow: LegalIdentity,
): boolean {
  if (!previous) return true;
  return (
    norm(previous.legalName) !== norm(approvedNow.legalName) ||
    norm(previous.legalEntityType) !== norm(approvedNow.legalEntityType)
  );
}

/** Who may approve a changed identity: not whoever changed it, and not one of its members. */
export function identityReviewerFailure(input: {
  actorUserId: string;
  changedByUserId: string | null;
  actorIsMember: boolean;
}): 'SAME_PERSON' | 'ORGANIZATION_MEMBER' | null {
  if (input.changedByUserId && input.changedByUserId === input.actorUserId) return 'SAME_PERSON';
  if (input.actorIsMember) return 'ORGANIZATION_MEMBER';
  return null;
}
