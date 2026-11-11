import type { Payout } from '@eticketsgo/web-kit';

/**
 * What the admin Payouts list offers on a row.
 *
 * A held payout (no verified bank account, a changed legal identity waiting for review, an
 * account not in the business's name - see `Payout.hold`) used to show the same "Mark paid"
 * button as a payable one, beside the reason it could not be paid. That presented an unpayable
 * payout as ready. It now offers no "Mark paid" until the hold clears; "Failed" stays, because a
 * held payout can still be one the organizer will never be paid. The API refuses a held payout
 * whatever the screen shows.
 */
export type PayoutRowAction = 'MISSING_DUTY' | 'PAYABLE' | 'HELD' | 'PAID' | 'FAILED' | 'NONE';

export function payoutRowAction(
  p: Pick<Payout, 'status' | 'hold'>,
  mayExecute: boolean,
): PayoutRowAction {
  const open = p.status === 'PENDING' || p.status === 'SCHEDULED';
  if (open && !mayExecute) return 'MISSING_DUTY';
  if (open) return p.hold ? 'HELD' : 'PAYABLE';
  if (p.status === 'PAID') return 'PAID';
  if (p.status === 'FAILED') return 'FAILED';
  return 'NONE';
}
