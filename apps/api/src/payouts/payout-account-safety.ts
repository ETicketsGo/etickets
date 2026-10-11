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
