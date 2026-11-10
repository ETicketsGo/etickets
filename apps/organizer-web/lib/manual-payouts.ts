import type { PayoutProviderEntry } from '@eticketsgo/shared-types';

/**
 * How an organizer is paid while the platform sends no automatic transfers: rupees while
 * Razorpay Route is off, and dollars while Stripe transfers are off (PAYOUT_EXECUTION_ENABLED).
 *
 * ── DOLLARS TOO ────────────────────────────────────────────────────────────────────
 * A Stripe charge lands on the platform account (separate charges and transfers), so a connected
 * account with payouts enabled receives nothing until the platform sends a transfer. With
 * transfers off the console still said "Payouts are active / Every payout setup you use is
 * ready" next to "No account on file. Your settlements cannot be paid until you add one." -
 * while the only way the organizer could be paid was that bank account. The server now reports
 * the Stripe stage PLATFORM_PAYOUTS_OFF in that case, and the same manual-settlement words apply.
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
export const AUTOMATIC_OFF_STRIPE =
  'Automatic payouts (Stripe transfers): not enabled. Nothing is needed from you.';

/**
 * True when this market is paid through manual settlements because the platform sends no
 * automatic transfers for it (Route off for rupees, transfers off for dollars).
 */
export function isManualPayout(e: Pick<PayoutProviderEntry, 'provider' | 'stage'>): boolean {
  return e.stage === 'PLATFORM_PAYOUTS_OFF';
}

/** Rupees only (Route off). Kept for callers that ask about rupees specifically. */
export function isManualRupeePayout(e: Pick<PayoutProviderEntry, 'provider' | 'stage'>): boolean {
  return e.provider === 'RAZORPAY' && isManualPayout(e);
}

export function manualPayoutLine(
  bank: PayoutProviderEntry['bank'],
  ownership: BankOwnership,
  provider: PayoutProviderEntry['provider'] = 'RAZORPAY',
): ManualPayoutLine {
  const AUTOMATIC = provider === 'STRIPE' ? AUTOMATIC_OFF_STRIPE : AUTOMATIC_OFF;
  if (bank === 'NONE' || bank === null) {
    return {
      payouts:
        'Manual settlements: add a bank account below. ETicketsGo pays your settlements by bank transfer.',
      payoutsTone: 'bad',
      bank: 'No bank account saved yet.',
      automatic: AUTOMATIC,
      organizerActionRequired: true,
    };
  }
  if (bank === 'REJECTED') {
    return {
      payouts: 'Manual settlements: on hold until your bank details are corrected.',
      payoutsTone: 'bad',
      bank: 'We could not verify your bank details. Check them and save them again.',
      automatic: AUTOMATIC,
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
      automatic: AUTOMATIC,
      organizerActionRequired: true,
    };
  }
  if (bank === 'UNDER_REVIEW') {
    return {
      payouts: 'Manual settlements: paid by bank transfer once we have checked your bank account.',
      payoutsTone: 'waiting',
      bank: 'Needs verification: we are checking your bank account.',
      automatic: AUTOMATIC,
      organizerActionRequired: false,
    };
  }
  return {
    payouts: 'Manual settlements: active. ETicketsGo pays your settlements by bank transfer.',
    payoutsTone: 'good',
    bank: 'Bank account verified.',
    automatic: AUTOMATIC,
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
