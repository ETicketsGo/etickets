/**
 * The tax that goes back with returned tickets, line by line.
 *
 * ── THE REPORT ─────────────────────────────────────────────────────────────────────
 * "Refund amount exceeds the remaining refundable balance" on a ₹522.82 booking for one ₹499
 * ticket. The refund was worked out as the ticket price PLUS every tax line re-applied to it:
 *
 *     ₹499 + ₹38.06 + ₹38.06 (ticket GST) + ₹1.82 + ₹1.82 (fee GST) = ₹578.76
 *
 * Two mistakes in one sum. Indian GST on admission is INSIDE the ₹499, so adding it again
 * refunds tax the customer never paid on top of the price. And the GST on the platform fee
 * went back although the fee itself does not. More than was paid, so every such refund was
 * refused.
 *
 * ── THE RULE, PER LINE ─────────────────────────────────────────────────────────────
 *   levied on FEES      → nothing goes back; fees are not refunded, so neither is their tax.
 *   INSIDE the price    → goes back inside the ticket price, not on top of it. Its share of
 *                         the line is recorded so the credit note can state the tax returned.
 *   ADDED to the price  → the rate re-applied to the tickets returned, capped at the line's
 *                         base (unchanged from before, and what a US-style sales tax needs).
 *
 * A line that predates `basis`/`inclusive` is treated as added, exactly as before this
 * change — rows written since 2026-09-06 state both.
 */
export interface TaxLineSnapshot {
  label: string;
  rateBasisPoints: number;
  baseMinor: number;
  amountMinor: number;
  basis?: string | null;
  inclusive?: boolean | null;
}

export interface RefundTaxLine {
  label: string;
  rateBasisPoints: number;
  basis: string | null;
  inclusive: boolean;
  baseMinor: number;
  amountMinor: number;
}

export interface RefundTax {
  /** Tax returned ON TOP of the ticket price. Part of the refund amount. */
  addedMinor: number;
  /** Tax already inside the ticket price being returned. Not added to the amount. */
  includedMinor: number;
  /** All tax the refund returns, however it was carried. */
  taxMinor: number;
  lines: RefundTaxLine[];
}

/**
 * @param ticketsMinor         the returned tickets at the price they were sold for
 * @param bookingTicketsMinor  every ticket on the booking at that price — the whole an
 *                             inclusive line was levied on, so a partial refund returns its
 *                             share of the line rather than re-deriving a rounded figure
 */
export function refundTax(
  lines: readonly TaxLineSnapshot[],
  ticketsMinor: number,
  bookingTicketsMinor: number,
): RefundTax {
  const share = bookingTicketsMinor > 0 ? Math.min(1, ticketsMinor / bookingTicketsMinor) : 0;
  const out: RefundTaxLine[] = [];
  for (const line of lines) {
    if (line.basis === 'FEES') continue;
    const common = {
      label: line.label,
      rateBasisPoints: line.rateBasisPoints,
      basis: line.basis ?? null,
    };
    if (line.inclusive === true) {
      out.push({
        ...common,
        inclusive: true,
        baseMinor: Math.round(line.baseMinor * share),
        amountMinor: Math.round(line.amountMinor * share),
      });
    } else {
      const base = Math.min(ticketsMinor, line.baseMinor);
      out.push({
        ...common,
        inclusive: false,
        baseMinor: base,
        amountMinor: Math.round((base * line.rateBasisPoints) / 10_000),
      });
    }
  }
  const addedMinor = out.filter((l) => !l.inclusive).reduce((s, l) => s + l.amountMinor, 0);
  const includedMinor = out.filter((l) => l.inclusive).reduce((s, l) => s + l.amountMinor, 0);
  return { addedMinor, includedMinor, taxMinor: addedMinor + includedMinor, lines: out };
}

/** Each ticket's sale price, by ticket type, from the booking's own item snapshot. */
export function ticketPrices(
  items: readonly { ticketTypeId: string | null; unitPriceMinor: number; quantity?: number }[],
): { priceByType: Map<string | null, number>; bookingTicketsMinor: number } {
  const ticketItems = items.filter((i) => i.ticketTypeId);
  return {
    priceByType: new Map(ticketItems.map((i) => [i.ticketTypeId, i.unitPriceMinor])),
    bookingTicketsMinor: ticketItems.reduce((s, i) => s + i.unitPriceMinor * (i.quantity ?? 1), 0),
  };
}
