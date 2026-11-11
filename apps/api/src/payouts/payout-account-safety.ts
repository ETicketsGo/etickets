import { bankOwnership } from '@eticketsgo/shared-types';
/**
 * Pure rules for payout bank-account safeguards. Nothing here reads a database, so each rule
 * can be tested on its own and cannot drift from the service that applies it.
 */

export type PayoutAccountReviewStatus = 'PENDING_VERIFICATION' | 'VERIFIED' | 'REJECTED';

/** The fields whose change is worth telling an owner about, in the order they are listed. */
export const WATCHED_FIELDS = ['holderName', 'bankName', 'bankCode', 'accountNumber'] as const;
export type WatchedField = (typeof WATCHED_FIELDS)[number];

/** Where an account stands. One answer, so the API, the history and both consoles agree. */
export function reviewStatusOf(row: {
  verifiedAt: Date | null;
  rejectedAt: Date | null;
}): PayoutAccountReviewStatus {
  if (row.verifiedAt) return 'VERIFIED';
  if (row.rejectedAt) return 'REJECTED';
  return 'PENDING_VERIFICATION';
}

/**
 * Which watched fields differ. `accountNumberChanged` is passed in rather than computed because
 * the numbers are ciphertext here: the service decides it (by decrypting for one comparison) and
 * the number itself never enters this function.
 */
export function changedFieldsOf(
  previous: { holderName: string; bankName: string; bankCode: string } | null,
  next: { holderName: string; bankName: string; bankCode: string },
  accountNumberChanged: boolean,
): WatchedField[] | 'initial' {
  if (!previous) return 'initial';
  const out: WatchedField[] = [];
  if (previous.holderName !== next.holderName) out.push('holderName');
  if (previous.bankName !== next.bankName) out.push('bankName');
  if (previous.bankCode !== next.bankCode) out.push('bankCode');
  if (accountNumberChanged) out.push('accountNumber');
  return out;
}

/**
 * Free text that looks like it carries an account number.
 *
 * A reason typed by staff is written to the audit log and, for a rejection, emailed to the
 * owners. A run of six or more digits (spaces and dashes allowed between them) is how an account
 * number looks, so it is refused rather than stored. Short numbers (a ticket id, "2 attempts")
 * are fine.
 */
export function looksLikeAccountNumber(text: string): boolean {
  // An ISO date is eight digits with dashes and is how staff naturally write "checked on".
  const withoutDates = text.replace(/\d{4}-\d{2}-\d{2}/g, ' ');
  return /\d(?:[\s-]?\d){5,}/.test(withoutDates);
}

/** Staff may not decide on an account they entered or that belongs to an organization they are in. */
export type IndependenceFailure = 'SAME_PERSON' | 'ORGANIZATION_MEMBER';

export function independenceFailure(input: {
  actorUserId: string;
  savedByUserId: string | null;
  actorIsMember: boolean;
}): IndependenceFailure | null {
  if (input.savedByUserId !== null && input.savedByUserId === input.actorUserId) {
    return 'SAME_PERSON';
  }
  if (input.actorIsMember) return 'ORGANIZATION_MEMBER';
  return null;
}

/**
 * Whether a payout may be marked PAID, judged by the bank account it would be paid into.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────────────
 * Money may be recorded as sent only to an account that somebody other than its maker has
 * verified, in its CURRENT version. An account saved or changed since its last verification is
 * pending, so a payout cannot be marked paid until a second person checks it. A payout that
 * moves no money to the organizer (net zero or a clawback) is exempt: there is no destination
 * to protect.
 */
export type PayoutDestinationVerdict =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | 'NO_ACCOUNT'
        | 'PENDING_VERIFICATION'
        | 'REJECTED'
        | 'OWNERSHIP_MISMATCH'
        | 'IDENTITY_NOT_APPROVED'
        | 'DISPUTED';
    };

/*
  ── WHOSE ACCOUNT IT IS ─────────────────────────────────────────────────────────────
  Verification says somebody checked the account; it did not say the account belongs to the
  business being paid. A company was payable into a verified PERSONAL account (seen in PROD:
  a private limited company whose rupee account is held by a person). A business - company,
  LLP, LLC, trust, society, partnership - is paid only into an account whose holder carries its
  registered legal name (`bankOwnership`, shared with the organizer console). A sole proprietor
  or an individual is paid in their own name and is not checked. Unknown facts (no legal name
  or legal form on file) are not guessed at: the verification rule above still applies.
*/
export function payoutDestinationVerdict(input: {
  netMinor: number;
  account: {
    verifiedAt: Date | null;
    rejectedAt: Date | null;
    holderName?: string | null;
    /** An owner said these details are not theirs. Holds every payout, whoever pays. */
    disputedAt?: Date | null;
  } | null;
  /**
   * The organizer's APPROVED legal identity (the snapshot staff approved, never the editable
   * fields). `approved: false` while a change waits for review: nothing is paid out then.
   */
  owner?: {
    approved?: boolean;
    legalName: string | null;
    legalEntityType: string | null;
  } | null;
}): PayoutDestinationVerdict {
  if (input.netMinor <= 0) return { allowed: true };
  if (input.owner && input.owner.approved === false) {
    return { allowed: false, reason: 'IDENTITY_NOT_APPROVED' };
  }
  if (!input.account) return { allowed: false, reason: 'NO_ACCOUNT' };
  if (input.account.disputedAt) return { allowed: false, reason: 'DISPUTED' };
  if (!input.account.verifiedAt) {
    return {
      allowed: false,
      reason: input.account.rejectedAt ? 'REJECTED' : 'PENDING_VERIFICATION',
    };
  }
  if (
    input.owner &&
    bankOwnership({
      holderName: input.account.holderName,
      legalName: input.owner.legalName,
      legalEntityType: input.owner.legalEntityType,
    }) === 'MISMATCH'
  ) {
    return { allowed: false, reason: 'OWNERSHIP_MISMATCH' };
  }
  return { allowed: true };
}

/**
 * Whoever verified the account version a payout would go into may not record that payout paid.
 * Identity only: no role, no capability, so a super admin is held to it exactly like anyone else.
 */
export function verifierMayNotPay(input: {
  actorUserId: string;
  verifiedByUserId: string | null | undefined;
}): boolean {
  return !!input.verifiedByUserId && input.verifiedByUserId === input.actorUserId;
}

/*
  ── FOUNDER-OPERATED PAYOUTS: THE ONE EXCEPTION TO "THE VERIFIER MAY NOT PAY" ─────────
  Owner decision 2026-11-11: ETicketsGo runs with one operator, the super admin. The rule above
  would stop every manual payout, because that one person must both verify the account and
  record the payment. This replaces "a different staff member" with checks one person cannot
  fake alone (docs/go-live/FOUNDER-OPERATED-CONTROLS.md):

  - the organizer, signed in to their own console, re-typed the full account number and bank
    code of THIS version and confirmed it is theirs;
  - the verifier recorded how they checked it (method and evidence reference);
  - at least 48 hours passed between verification and payment;
  - the payment carries the bank reference, the amount typed again, and an attestation.

  Never for anyone but a SUPER_ADMIN, never for an organization they belong to, and only while
  SOLE_OPERATOR_MODE is on. Bank ownership, approved identity, disputes, provider-transfer
  claims and the duplicate-payment claim are checked before this and are not relaxed by it.
*/

/** How long verification must stand before the same person may record a payment into it. */
export const SOLE_OPERATOR_WAIT_MS = 48 * 60 * 60 * 1000;

/** How a verifier checked a bank account. */
export const VERIFICATION_METHODS = [
  'PENNY_DROP',
  'BANK_LETTER',
  'CANCELLED_CHEQUE',
  'BANK_STATEMENT',
] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

export type SoleOperatorUnmet =
  | 'MODE_OFF'
  | 'NOT_SUPER_ADMIN'
  | 'ORGANIZATION_MEMBER'
  | 'NOT_CONFIRMED_BY_ORGANIZER'
  | 'NO_VERIFICATION_EVIDENCE'
  | 'WAITING_PERIOD'
  | 'BANK_REFERENCE_REQUIRED'
  | 'AMOUNT_NOT_CONFIRMED'
  | 'ATTESTATION_REQUIRED';

/**
 * What still stands between this verifier and recording the payment. Empty means the exception
 * applies. The first three are absolute (nothing the operator does at payment time changes them)
 * and are returned alone.
 */
export function soleOperatorUnmet(input: {
  modeOn: boolean;
  actorIsSuperAdmin: boolean;
  actorIsMember: boolean;
  account: {
    version: number;
    verifiedAt: Date | null;
    ownerConfirmedAt: Date | null;
    ownerConfirmedVersion: number | null;
    verificationMethod: string | null;
    verificationEvidence: string | null;
  };
  reference: string | null;
  amountConfirmedMinor: number | null | undefined;
  netMinor: number;
  attested: boolean;
  now: Date;
}): SoleOperatorUnmet[] {
  if (!input.modeOn) return ['MODE_OFF'];
  if (!input.actorIsSuperAdmin) return ['NOT_SUPER_ADMIN'];
  if (input.actorIsMember) return ['ORGANIZATION_MEMBER'];
  const out: SoleOperatorUnmet[] = [];
  const a = input.account;
  if (!a.ownerConfirmedAt || a.ownerConfirmedVersion !== a.version) {
    out.push('NOT_CONFIRMED_BY_ORGANIZER');
  }
  if (!a.verificationMethod || !a.verificationEvidence) out.push('NO_VERIFICATION_EVIDENCE');
  if (!a.verifiedAt || input.now.getTime() - a.verifiedAt.getTime() < SOLE_OPERATOR_WAIT_MS) {
    out.push('WAITING_PERIOD');
  }
  if (!input.reference) out.push('BANK_REFERENCE_REQUIRED');
  if (input.amountConfirmedMinor !== input.netMinor) out.push('AMOUNT_NOT_CONFIRMED');
  if (!input.attested) out.push('ATTESTATION_REQUIRED');
  return out;
}

/** One sentence per unmet condition, in the words the admin console shows. */
export const SOLE_OPERATOR_UNMET_MESSAGES: Record<SoleOperatorUnmet, string> = {
  MODE_OFF: 'Sole-operator controls are off on this server.',
  NOT_SUPER_ADMIN:
    'Only the super admin may pay into an account they verified, and only under sole-operator controls.',
  ORGANIZATION_MEMBER:
    'You belong to this organization, so you can never pay it into an account you verified.',
  NOT_CONFIRMED_BY_ORGANIZER:
    'An owner of the organization has not confirmed this version of the bank account in their own console.',
  NO_VERIFICATION_EVIDENCE:
    'The verification has no recorded method and evidence reference. Ask the owner to save the account again and verify it with evidence.',
  WAITING_PERIOD: 'Wait until 48 hours have passed since you verified the bank account.',
  BANK_REFERENCE_REQUIRED: 'Enter the bank reference (UTR or ACH trace) of the transfer.',
  AMOUNT_NOT_CONFIRMED: 'Type the exact amount you transferred.',
  ATTESTATION_REQUIRED:
    'Confirm that you are the only operator and that you checked the transfer on the bank statement.',
};
