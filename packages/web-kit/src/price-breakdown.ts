/**
 * What a buyer sees before they commit, and the one rule it must obey.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────────────
 * The amounts a customer can see above the total must add up to the total. That sounds
 * too obvious to write down, and it has now been broken twice on this platform in the
 * same way, so it is written down here and tested.
 *
 * Both breakages were the same mistake: tax that is INSIDE the price rendered as though it
 * were being ADDED to it. Indian GST on an admission is inclusive — the ₹150 on the ticket
 * already contains it — so listing it as its own row invites the reader to add it and get
 * a number nobody is charging them. On a real two-seat cart the rows came to ₹400.98
 * against a total of ₹355.22.
 *
 *   - The receipt did it first, and a customer noticed.
 *   - The storefront did it too, found by an e2e assertion that the rows foot.
 *
 * ── WHY THIS IS DATA AND NOT JSX ───────────────────────────────────────────────────
 * The decision — which amounts belong above the total, which belong below it, and what the
 * platform's fee comes to all-in — is arithmetic, and arithmetic is testable. The
 * component turns the result into rows and translated labels. Neither half can quietly
 * change the money.
 */

export interface BreakdownTaxLine {
  label: string;
  rateBasisPoints: number;
  amountMinor: number;
  /** What the line was levied on. Absent on an older API, which itemised everything. */
  basis?: 'TICKETS' | 'FEES' | 'TICKETS_AND_FEES';
  /** Whether the tax sat inside the price rather than being added to it. */
  inclusive?: boolean;
}

export interface BreakdownQuote {
  subtotalMinor: number;
  discountMinor: number;
  bookingFeeMinor: number;
  paymentFeeMinor: number;
  /** The platform fee all-in. Absent on an older API. */
  customerFeeInclusiveMinor?: number;
  customerFeeMinor?: number;
  /** The combined rate inside the all-in fee — 1800 for 18%, 0 when untaxed. */
  feeTaxRateBasisPoints?: number;
  taxLines?: BreakdownTaxLine[];
  totalMinor: number;
}

export type BreakdownRowKind = 'tickets' | 'discount' | 'platformFee' | 'tax';

export interface BreakdownRow {
  kind: BreakdownRowKind;
  /** Signed: a discount subtracts. This is the number that must foot. */
  amountMinor: number;
  /** Present on tax rows, for "CGST (9%)". */
  label?: string;
  rateBasisPoints?: number;
}

export interface Breakdown {
  /** Shown above the total. These MUST sum to `totalMinor`. */
  rows: BreakdownRow[];
  /** Shown below the total, worded as already included. Not part of the sum. */
  includedTax: BreakdownTaxLine[];
  /** The rate named inside the platform-fee label; 0 when the fee is untaxed. */
  platformFeeRateBasisPoints: number;
  totalMinor: number;
}

export function priceBreakdown(quote: BreakdownQuote): Breakdown {
  /*
    All-in when the API supplies it, and the two fee components added together when it does
    not — an older API is still correct, just without the fee's tax folded in.
  */
  const platformFeeMinor =
    quote.customerFeeInclusiveMinor ??
    quote.customerFeeMinor ??
    quote.bookingFeeMinor + quote.paymentFeeMinor;

  /*
    Tax on the FEE is excluded from both lists: it is already stated inside the fee row, and
    listing it again would show the same money twice.

    Filtered on `basis`, which the API states. Working out which line was the fee's by
    comparing amounts is a guess, and it is wrong the moment the tax is inclusive — the base
    is then the fee minus its own tax.
  */
  const ticketTax = (quote.taxLines ?? []).filter((tax) => tax.basis !== 'FEES');

  const rows: BreakdownRow[] = [{ kind: 'tickets', amountMinor: quote.subtotalMinor }];
  if (quote.discountMinor > 0) {
    rows.push({ kind: 'discount', amountMinor: -quote.discountMinor });
  }
  if (platformFeeMinor > 0) {
    rows.push({ kind: 'platformFee', amountMinor: platformFeeMinor });
  }
  for (const tax of ticketTax.filter((t) => !t.inclusive)) {
    rows.push({
      kind: 'tax',
      amountMinor: tax.amountMinor,
      label: tax.label,
      rateBasisPoints: tax.rateBasisPoints,
    });
  }

  return {
    rows,
    includedTax: ticketTax.filter((tax) => tax.inclusive === true),
    platformFeeRateBasisPoints: quote.feeTaxRateBasisPoints ?? 0,
    totalMinor: quote.totalMinor,
  };
}
