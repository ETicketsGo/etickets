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
 * The decision — which amounts belong above the total, which are already inside the ticket
 * price, and how the fee divides — is arithmetic, and arithmetic is testable. The component
 * turns the result into rows and translated labels. Neither half can quietly change the money.
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
  /** The customer's fees all-in, tax on them included. Absent on an older API. */
  customerFeeInclusiveMinor?: number;
  /** The customer's share of the booking + payment fees, before tax on them. */
  customerFeeMinor?: number;
  /** The combined rate charged on the fees — 1800 for 18%, 0 when untaxed. */
  feeTaxRateBasisPoints?: number;
  /** Tax on the fees, in minor units. Zero or absent when the fees are untaxed. */
  feeTaxMinor?: number;
  /** A statutory per-ticket maintenance charge for the order, if one applies. */
  maintenanceMinor?: number;
  maintenanceTreatment?: MaintenanceTreatment;
  taxLines?: BreakdownTaxLine[];
  totalMinor: number;
}

/**
 * `paymentFee` — what the card or UPI network charges to move the money.
 * `platformFee` — ETicketsGo's own booking fee.
 * `feeTax`     — tax charged on those two.
 * `fees`       — the two together, only when a booking cannot be divided exactly.
 */
export type BreakdownRowKind =
  'tickets' | 'discount' | 'maintenance' | 'tax' | 'paymentFee' | 'platformFee' | 'feeTax' | 'fees';

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
  /** Already inside the ticket price — disclosed with the tickets, never added. */
  includedTax: BreakdownTaxLine[];
  /**
   * A maintenance charge already inside the ticket price — disclosed with the tickets, never
   * added to the total. Zero when none applies or when the charge was added instead.
   */
  includedMaintenanceMinor: number;
  /** The rate charged on the fees; 0 when they are untaxed. */
  platformFeeRateBasisPoints: number;
  /**
   * Everything the customer pays on top of the tickets, and what it is made of. The parts sum
   * to `totalMinor`, and they are exactly the fee rows above.
   */
  platformFee: {
    totalMinor: number;
    bookingFeeMinor: number;
    paymentFeeMinor: number;
    /** Tax charged on the fees. */
    taxMinor: number;
  };
  totalMinor: number;
}

export function priceBreakdown(quote: BreakdownQuote): Breakdown {
  /*
    All-in when the API supplies it, and the two fee components added together when it does
    not — an older API is still correct, just without the fee's tax folded in.
  */
  /*
    ── WHEN THE ALL-IN FIGURE IS MISSING ────────────────────────────────────────────
    A booking read back from the API carried only the fee before tax, so its breakdown had no
    GST on the fees: Review & pay showed ₹499 + ₹10.18 + ₹10 under a total of ₹522.82. The tax
    lines levied on the fees are on the booking, so the all-in figure is rebuilt from them —
    the same arithmetic the quote does — rather than letting the rows fall short of the total.
  */
  const feeTaxLines = (quote.taxLines ?? []).filter((t) => t.basis === 'FEES');
  const addedFeeTaxMinor = feeTaxLines
    .filter((t) => t.inclusive === false)
    .reduce((n, t) => n + t.amountMinor, 0);
  const feeTaxRateBasisPoints =
    quote.feeTaxRateBasisPoints ?? feeTaxLines.reduce((n, t) => n + t.rateBasisPoints, 0);
  const feesAllInMinor =
    quote.customerFeeInclusiveMinor ??
    (quote.customerFeeMinor ?? quote.bookingFeeMinor + quote.paymentFeeMinor) + addedFeeTaxMinor;

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
    feesAllInMinor +
    addedMaintenance +
    declared
      .filter((t) => !t.inclusive && t.basis !== 'FEES')
      .reduce((n, t) => n + t.amountMinor, 0);
  const undeclaredSum = undeclared.reduce((n, t) => n + t.amountMinor, 0);
  /*
    Added only when adding them is what reaches the total. Anything else — including a
    booking whose numbers do not reconcile for some third reason — is disclosed as included
    instead, because an inaccurate DESCRIPTION of tax that is already paid is a much smaller
    wrong than a column of figures that does not sum to what is being charged.
  */
  const undeclaredWereAdded =
    undeclaredSum > 0 && withoutUndeclared + undeclaredSum === quote.totalMinor;

  const resolvedTax: BreakdownTaxLine[] = [
    ...declared,
    ...undeclared.map((t) => ({ ...t, inclusive: !undeclaredWereAdded })),
  ];

  /*
    Tax on the FEES is excluded from both lists: it has its own fee row below, and listing
    the lines again would show the same money twice.

    Filtered on `basis`, which the API states. Working out which line was the fee's by
    comparing amounts is a guess, and it is wrong the moment the tax is inclusive — the base
    is then the fee minus its own tax.
  */
  const ticketTax = resolvedTax.filter((tax) => tax.basis !== 'FEES');

  const rows: BreakdownRow[] = [{ kind: 'tickets', amountMinor: quote.subtotalMinor }];
  if (quote.discountMinor > 0) {
    rows.push({ kind: 'discount', amountMinor: -quote.discountMinor });
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

  /*
    ── THE FEES, EACH ON ITS OWN LINE ───────────────────────────────────────────────
    They were one "Platform fee (incl. 18% GST)" row that opened to show its parts. Reported
    from QA: "it is not good to include the payment fee in the platform fee — the user thinks
    we are taking it". The payment fee is what the card or UPI network charges; folding it into
    a row named after the platform said the opposite.

    So: payment processing, the platform's own fee, and the tax on both, as three rows.

    The booking can carry the FULL fees while the customer pays only a share of them (the
    organizer covers the rest). The customer's share is then divided in the same proportion,
    so the rows still foot to what they are charged. With no share to divide by — an older API
    — the two are one row rather than a guess.
  */
  const parts = feeParts(quote, feesAllInMinor);
  if (parts) {
    if (parts.paymentFeeMinor > 0)
      rows.push({ kind: 'paymentFee', amountMinor: parts.paymentFeeMinor });
    if (parts.bookingFeeMinor > 0)
      rows.push({ kind: 'platformFee', amountMinor: parts.bookingFeeMinor });
    if (parts.taxMinor > 0) {
      rows.push({
        kind: 'feeTax',
        amountMinor: parts.taxMinor,
        rateBasisPoints: feeTaxRateBasisPoints,
      });
    }
  } else if (feesAllInMinor > 0) {
    rows.push({ kind: 'fees', amountMinor: feesAllInMinor });
  }

  return {
    rows,
    includedTax: mergeByRate(ticketTax.filter((tax) => tax.inclusive === true)),
    includedMaintenanceMinor: maintenanceMinor > 0 && !added ? maintenanceMinor : 0,
    platformFeeRateBasisPoints: feeTaxRateBasisPoints,
    platformFee: {
      totalMinor: feesAllInMinor,
      bookingFeeMinor: parts?.bookingFeeMinor ?? quote.bookingFeeMinor,
      paymentFeeMinor: parts?.paymentFeeMinor ?? quote.paymentFeeMinor,
      taxMinor:
        parts?.taxMinor ??
        Math.max(0, feesAllInMinor - quote.bookingFeeMinor - quote.paymentFeeMinor),
    },
    totalMinor: quote.totalMinor,
  };
}

/**
 * The customer's fees divided into payment processing, platform fee and tax — or null when
 * they cannot be divided without inventing a number.
 *
 * Always sums to `feesAllInMinor`: the payment part is rounded, the platform part takes the
 * remainder of the pre-tax share, and the tax is what is left of the all-in figure.
 */
function feeParts(
  quote: BreakdownQuote,
  feesAllInMinor: number,
): { paymentFeeMinor: number; bookingFeeMinor: number; taxMinor: number } | null {
  const fullMinor = quote.bookingFeeMinor + quote.paymentFeeMinor;
  const shareMinor =
    quote.customerFeeMinor ??
    (quote.customerFeeInclusiveMinor === undefined ? fullMinor : undefined);
  if (shareMinor === undefined || shareMinor < 0 || shareMinor > feesAllInMinor) return null;
  const paymentFeeMinor =
    fullMinor <= 0
      ? 0
      : shareMinor === fullMinor
        ? quote.paymentFeeMinor
        : Math.round((quote.paymentFeeMinor * shareMinor) / fullMinor);
  return {
    paymentFeeMinor,
    bookingFeeMinor: shareMinor - paymentFeeMinor,
    taxMinor: feesAllInMinor - shareMinor,
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
 * is in this — with one number. Amounts are summed, so nothing is lost.
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
