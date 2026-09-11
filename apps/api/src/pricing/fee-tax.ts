/**
 * The tax on a customer's fees, read back from the tax lines a booking stored.
 *
 * ── WHY A BOOKING NEEDS THIS ───────────────────────────────────────────────────────
 * The checkout quote reports the platform fees all-in — fee plus the GST charged on it — and
 * the storefront's breakdown relies on that figure to show "GST on fees". A booking read back
 * afterwards carried only the fee before tax, so the payment screen for the same order listed
 * ₹499 + ₹10.18 + ₹10 and a total of ₹522.82: the ₹3.64 of GST on the fees had nowhere to go.
 *
 * Derived here from the lines the booking already stores, with the same rule the quote uses
 * (`PricingService`), so the two can only agree.
 */
export interface FeeTaxLine {
  basis?: string | null;
  inclusive?: boolean | null;
  amountMinor: number;
  rateBasisPoints: number;
}

export interface FeeTaxSummary {
  /** The customer's fees with any tax ADDED to them. Equal to the fee when the tax was inside. */
  customerFeeInclusiveMinor: number;
  /** All tax levied on the fees, however it was carried. */
  feeTaxMinor: number;
  /** CGST 9% + SGST 9% reads as one 18% levy, so the components are summed. */
  feeTaxRateBasisPoints: number;
}

export function feeTaxSummary(
  taxLines: readonly FeeTaxLine[] | null | undefined,
  customerFeeMinor: number,
): FeeTaxSummary {
  const onFees = (taxLines ?? []).filter((line) => line.basis === 'FEES');
  const added = onFees
    .filter((line) => line.inclusive !== true)
    .reduce((sum, line) => sum + line.amountMinor, 0);
  return {
    customerFeeInclusiveMinor: customerFeeMinor + added,
    feeTaxMinor: onFees.reduce((sum, line) => sum + line.amountMinor, 0),
    feeTaxRateBasisPoints: onFees.reduce((sum, line) => sum + line.rateBasisPoints, 0),
  };
}
