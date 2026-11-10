import type { PayoutProviderEntry } from '@eticketsgo/shared-types';

/**
 * How an Indian organizer is paid while automatic Razorpay Route payouts are switched off.
 *
 * ── THE DEFECT THIS EXISTS FOR ──────────────────────────────────────────────────────
 * Rupee payouts have two paths. Razorpay Route (automatic transfers) is a switch on OUR
 * platform account and is off. The payout ledger (manual settlements) is always on: the
 * organizer generates a settlement once an event has finished and its holding period has
 * passed, a member of staff who did not check the bank account pays it by bank transfer and
 * records the bank reference, and the organizer sees it as Paid.
 *
 * The console only knew the first path. With Route off it told every Indian organizer
 * "Payouts are not active yet" and "We are not making payouts to this account yet", next to a
 * Settlements table that does pay them. These rules say what is actually true.
 */

/** Legal forms whose money belongs to a business, not to a person. */
const PERSONAL_ENTITY_TYPES = new Set(
  ['sole proprietorship', 'sole proprietor', 'individual', 'hindu undivided family'].map((s) =>
    s.toLowerCase(),
  ),
);

/** Words that only describe the legal form; they do not identify the business. */
const FORM_WORDS = new Set([
  'private',
  'pvt',
  'public',
  'limited',
  'ltd',
  'llp',
  'llc',
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'co',
  'company',
  'the',
  'and',
  'of',
]);

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);

export type BankOwnership = 'MATCH' | 'MISMATCH' | 'NOT_CHECKED';

/**
 * Whether the bank account looks like the BUSINESS's account.
 *
 * Only asked of a business (a company, LLP, partnership, trust, society, LLC...): a sole
 * proprietor or an individual is paid in their own name. The account holder must carry every
 * identifying word of the registered legal name; "DeepTrics Software Solutions Pvt Ltd" is
 * matched by "DEEPTRICS SOFTWARE SOLUTIONS PRIVATE LIMITED", not by a person's name.
 *
 * A screen-level warning, never a decision: staff verify ownership against a bank document.
 * It exists so a personal account is never shown as ready for company payouts.
 */
export function bankOwnership(input: {
  holderName: string | null | undefined;
  legalName: string | null | undefined;
  legalEntityType: string | null | undefined;
}): BankOwnership {
  const { holderName, legalName, legalEntityType } = input;
  if (!holderName?.trim() || !legalName?.trim() || !legalEntityType?.trim()) return 'NOT_CHECKED';
  if (PERSONAL_ENTITY_TYPES.has(legalEntityType.trim().toLowerCase())) return 'NOT_CHECKED';
  const core = words(legalName).filter((w) => !FORM_WORDS.has(w));
  if (core.length === 0) return 'NOT_CHECKED';
  const holder = new Set(words(holderName));
  return core.every((w) => holder.has(w)) ? 'MATCH' : 'MISMATCH';
}

export interface ManualPayoutLine {
  /** "Receiving payouts" for this market. */
  payouts: string;
  payoutsTone: 'good' | 'waiting' | 'bad';
  /** "Bank account" for this market. */
  bank: string;
  /** The second path, said plainly so nobody reads it as the only one. */
  automatic: string;
  organizerActionRequired: boolean;
}

export const AUTOMATIC_OFF =
  'Automatic payouts (Razorpay Route): not enabled. Nothing is needed from you.';

/** True when rupee payouts run through manual settlements because Route is off. */
export function isManualRupeePayout(e: Pick<PayoutProviderEntry, 'provider' | 'stage'>): boolean {
  return e.provider === 'RAZORPAY' && e.stage === 'PLATFORM_PAYOUTS_OFF';
}

export function manualPayoutLine(
  bank: PayoutProviderEntry['bank'],
  ownership: BankOwnership,
): ManualPayoutLine {
  if (bank === 'NONE' || bank === null) {
    return {
      payouts:
        'Manual settlements: add a bank account below. ETicketsGo pays your settlements by bank transfer.',
      payoutsTone: 'bad',
      bank: 'No bank account saved yet.',
      automatic: AUTOMATIC_OFF,
      organizerActionRequired: true,
    };
  }
  if (bank === 'REJECTED') {
    return {
      payouts: 'Manual settlements: on hold until your bank details are corrected.',
      payoutsTone: 'bad',
      bank: 'We could not verify your bank details. Check them and save them again.',
      automatic: AUTOMATIC_OFF,
      organizerActionRequired: true,
    };
  }
  if (ownership === 'MISMATCH') {
    return {
      payouts:
        'Manual settlements: on hold. Company payouts need a bank account in the company name.',
      payoutsTone: 'bad',
      bank:
        bank === 'VERIFIED'
          ? 'Ownership mismatch: the account holder is not your registered business name. Add the company account below.'
          : 'Ownership mismatch: the account holder is not your registered business name.',
      automatic: AUTOMATIC_OFF,
      organizerActionRequired: true,
    };
  }
  if (bank === 'UNDER_REVIEW') {
    return {
      payouts: 'Manual settlements: paid by bank transfer once we have checked your bank account.',
      payoutsTone: 'waiting',
      bank: 'Needs verification: we are checking your bank account.',
      automatic: AUTOMATIC_OFF,
      organizerActionRequired: false,
    };
  }
  return {
    payouts: 'Manual settlements: active. ETicketsGo pays your settlements by bank transfer.',
    payoutsTone: 'good',
    bank: 'Bank account verified.',
    automatic: AUTOMATIC_OFF,
    organizerActionRequired: false,
  };
}

/** A settlement row's status, in the words of the manual process. */
export function settlementStatusWords(status: string): string {
  switch (status) {
    case 'PENDING':
      return 'Pending approval';
    case 'SCHEDULED':
      return 'Scheduled';
    case 'PAID':
      return 'Paid';
    case 'FAILED':
      return 'Failed';
    default:
      return status.charAt(0) + status.slice(1).toLowerCase().replaceAll('_', ' ');
  }
}
