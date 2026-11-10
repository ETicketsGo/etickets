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

import type { BankOwnership } from '@eticketsgo/shared-types';

// The rule lives in shared-types so the API's payout hold and this screen are the same answer.
export { bankOwnership, type BankOwnership } from '@eticketsgo/shared-types';

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
