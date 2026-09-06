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

import type { MaintenanceTreatment } from '@eticketsgo/shared-types';

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
  /** Tax inside the all-in fee, in minor units. Zero or absent when the fee is untaxed. */
  feeTaxMinor?: number;
  /** A statutory per-ticket maintenance charge for the order, if one applies. */
  maintenanceMinor?: number;
  maintenanceTreatment?: MaintenanceTreatment;
  taxLines?: BreakdownTaxLine[];
  totalMinor: number;
}

export type BreakdownRowKind = 'tickets' | 'discount' | 'platformFee' | 'maintenance' | 'tax';

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
  /**
   * A maintenance charge already inside the ticket price — disclosed below the total, never
   * added to it. Zero-length when none applies or when the charge was added instead.
   */
  includedMaintenanceMinor: number;
  /** The rate named inside the platform-fee label; 0 when the fee is untaxed. */
  platformFeeRateBasisPoints: number;
  /**
   * What the single platform-fee row is MADE OF, for a surface that wants to show it.
   *
   * ── WHY BOTH A TOTAL AND ITS PARTS ─────────────────────────────────────────────
   * The row stays one line because "what does this platform cost me" is one question, and
   * three lines hand the customer arithmetic to do. But the parts go to different places —
   * the booking fee is the platform's, the payment fee covers processing the card — and a
   * buyer who wants to know that is entitled to. So the aggregate is what is shown, and this
   * is what can be opened.
   *
   * These MUST sum to the platform-fee row. A surface that shows the parts instead of the
   * total is showing the same money, not different money.
   */
  platformFee: {
    totalMinor: number;
    bookingFeeMinor: number;
    paymentFeeMinor: number;
    /** Tax charged on the fee itself, already inside `totalMinor`. */
    taxMinor: number;
  };
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
    ── A STORED LINE THAT CANNOT SAY WHAT IT IS ─────────────────────────────────────
    `basis` and `inclusive` were not persisted on `BookingTaxLine` until recently, so a
    booking made before then returns tax lines that state neither. Both defaults are wrong:
    an unknown basis is treated as "not the fee's", and an unknown inclusiveness as "added",
    which is precisely how "Review & pay" came to list four GST rows — the two on the tickets,
    already inside the price, and the two on the fee, already inside the fee row — above a
    total that none of them footed to.

    The answer is not a guess. The total is known, and so is everything else on the booking,
    so whether tax was ADDED is arithmetic: if the rows without it already reach the total,
    nothing was added. That is a fact about this booking, not an assumption about the market
    it was sold in.
  */
  const declared = (quote.taxLines ?? []).filter((t) => t.inclusive !== undefined);
  const undeclared = (quote.taxLines ?? []).filter((t) => t.inclusive === undefined);

  const addedMaintenance =
    quote.maintenanceTreatment === 'ADDED_TO_TICKET_PRICE' ? (quote.maintenanceMinor ?? 0) : 0;
  const withoutUndeclared =
    quote.subtotalMinor -
    quote.discountMinor +
    platformFeeMinor +
    addedMaintenance +
    declared
      .filter((t) => !t.inclusive && t.basis !== 'FEES')
      .reduce((n, t) => n + t.amountMinor, 0);
  const undeclaredSum = undeclared.reduce((n, t) => n + t.amountMinor, 0);
  /*
    Added only when adding them is what reaches the total. Anything else — including a
    booking whose numbers do not reconcile for some third reason — is disclosed below the
    total instead, because an inaccurate DESCRIPTION of tax that is already paid is a much
    smaller wrong than a column of figures that does not sum to what is being charged.
  */
  const undeclaredWereAdded =
    undeclaredSum > 0 && withoutUndeclared + undeclaredSum === quote.totalMinor;

  const resolvedTax: BreakdownTaxLine[] = [
    ...declared,
    ...undeclared.map((t) => ({ ...t, inclusive: !undeclaredWereAdded })),
  ];

  /*
    Tax on the FEE is excluded from both lists: it is already stated inside the fee row, and
    listing it again would show the same money twice.

    Filtered on `basis`, which the API states. Working out which line was the fee's by
    comparing amounts is a guess, and it is wrong the moment the tax is inclusive — the base
    is then the fee minus its own tax.
  */
  const ticketTax = resolvedTax.filter((tax) => tax.basis !== 'FEES');

  const rows: BreakdownRow[] = [{ kind: 'tickets', amountMinor: quote.subtotalMinor }];
  if (quote.discountMinor > 0) {
    rows.push({ kind: 'discount', amountMinor: -quote.discountMinor });
  }
  if (platformFeeMinor > 0) {
    rows.push({ kind: 'platformFee', amountMinor: platformFeeMinor });
  }

  /*
    ── A MAINTENANCE CHARGE IS A ROW ONLY WHEN IT IS ADDED ──────────────────────────
    An INCLUDED charge is already inside the ticket price the customer is paying, exactly as
    an inclusive tax is. Putting it in the rows would ask them to add it a second time and
    produce a column that does not foot — the same defect this file already exists to
    prevent, arriving through a new column.
  */
  const maintenanceMinor = quote.maintenanceMinor ?? 0;
  const added = quote.maintenanceTreatment === 'ADDED_TO_TICKET_PRICE';
  if (maintenanceMinor > 0 && added) {
    rows.push({ kind: 'maintenance', amountMinor: maintenanceMinor });
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
    includedTax: mergeByRate(ticketTax.filter((tax) => tax.inclusive === true)),
    includedMaintenanceMinor: maintenanceMinor > 0 && !added ? maintenanceMinor : 0,
    platformFeeRateBasisPoints: quote.feeTaxRateBasisPoints ?? 0,
    platformFee: {
      totalMinor: platformFeeMinor,
      bookingFeeMinor: quote.bookingFeeMinor,
      paymentFeeMinor: quote.paymentFeeMinor,
      /*
        Derived rather than trusted, so the parts always foot to the whole.

        `feeTaxMinor` is what the API says the fee's tax was; the difference is what is left
        after the two components. They agree in every case the API is correct, and when they
        do not, the number that must be right is the one that makes the disclosure add up to
        the row above it — otherwise opening the detail shows a customer a contradiction.
      */
      taxMinor: Math.max(0, platformFeeMinor - quote.bookingFeeMinor - quote.paymentFeeMinor),
    },
    totalMinor: quote.totalMinor,
  };
}

/**
 * One line per rate, not one per calculation.
 *
 * A cart can produce several lines carrying the same label — CGST on the tickets and CGST on
 * the platform fee, or two ticket bands taxed at the same rate. Listed separately they read
 * as two different taxes, and the reported screen showed exactly that: "CGST (9%)" twice with
 * different amounts and nothing to say which was which.
 *
 * Merging by label and rate answers the question a buyer is actually asking — how much CGST
 * is in this — with one number. Amounts are summed, so nothing is lost, and the bases are
 * added too so the arithmetic on a receipt still reproduces.
 */
function mergeByRate(lines: BreakdownTaxLine[]): BreakdownTaxLine[] {
  const merged = new Map<string, BreakdownTaxLine>();
  for (const line of lines) {
    const key = `${line.label}|${line.rateBasisPoints}`;
    const seen = merged.get(key);
    if (!seen) {
      merged.set(key, { ...line });
      continue;
    }
    seen.amountMinor += line.amountMinor;
  }
  return [...merged.values()];
}
