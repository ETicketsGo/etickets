import { organizerShareOfRefund } from '../../payouts/currency-settlement.calculator';

/** The fields of our own Refund row that decide whose money it returns. */
export interface OwnRefundRow {
  amountMinor: number;
  taxAddedMinor: number | null;
  platformFeeRefundedMinor: number | null;
}

/**
 * The organizer's share of a refund the provider just reported, for `SettlementService.applyRefund`.
 *
 * When our own COMPLETED Refund row(s) explain exactly this refund, the share is the documented
 * rule the payout ledger uses (`organizerShareOfRefund`: amount less tax added less the platform
 * fees returned). A pro-rata split of the payment would charge the organizer for part of the
 * platform's fee on every refund, and the settlement would stop agreeing with the payout ledger.
 *
 * Fallback: with no matching row (a refund made in the provider dashboard, or an amount our rows
 * do not explain) there is nothing to read the split from, so the old pro-rata share is kept.
 */
export function organizerShareOfProviderRefund(
  deltaMinor: number,
  ownRows: readonly OwnRefundRow[],
  payment: { amountMinor: number; organizerNetMinor: number },
): number {
  const explained = ownRows.reduce((sum, r) => sum + r.amountMinor, 0);
  if (ownRows.length > 0 && explained === deltaMinor) {
    return ownRows.reduce((sum, r) => sum + organizerShareOfRefund({ currency: '', ...r }), 0);
  }
  return payment.amountMinor > 0
    ? Math.round((deltaMinor * payment.organizerNetMinor) / payment.amountMinor)
    : 0;
}
