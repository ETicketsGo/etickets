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

/**
 * What each ticket on a booking actually cost the customer, after the booking's discount.
 *
 * ── THE REPORT ─────────────────────────────────────────────────────────────────────
 * Tickets were refunded at `unitPriceMinor`, the price BEFORE the coupon. A 50% coupon on two
 * ₹500 tickets took ₹500; refunding one ticket returned the whole ₹500, and the second was
 * then refused as exceeding the balance. The discount is carried by the tickets it was taken
 * from, so it has to come back off them.
 *
 * ── HOW IT IS SHARED OUT ───────────────────────────────────────────────────────────
 * The discount is applied to the whole subtotal, so each ticket keeps the same fraction of its
 * price: (subtotal − discount) / subtotal. Rounding is cumulative over the booking's tickets in
 * a fixed order (by id), so however the tickets are split across partial refunds, returning all
 * of them adds up to exactly the discounted ticket total — never a paisa more or less.
 *
 * ── TWO LINES OF ONE TYPE ──────────────────────────────────────────────────────────
 * Prices were keyed by ticket type, so a second line of the same type at a different price was
 * overwritten and every ticket of that type took the last line's price. A ticket does not
 * record which line it came from, so the type's units are dealt out to its tickets in a fixed
 * order: individual tickets may swap prices, but the type's total is always its lines' total.
 */
export function ticketNetPrices(
  items: readonly {
    id?: string;
    ticketTypeId: string | null;
    unitPriceMinor: number;
    quantity?: number;
  }[],
  tickets: readonly { id: string; ticketTypeId: string }[],
  booking: { subtotalMinor?: number | null; discountMinor?: number | null },
): { netByTicket: Map<string, number>; bookingTicketsMinor: number } {
  const byId = (a: { id?: string }, b: { id?: string }) => (a.id ?? '').localeCompare(b.id ?? '');
  const ticketItems = items.filter((i) => i.ticketTypeId).sort(byId);

  // Every unit each type was sold at, in line order.
  const unitsByType = new Map<string, number[]>();
  for (const item of ticketItems) {
    const units = unitsByType.get(item.ticketTypeId as string) ?? [];
    for (let n = 0; n < (item.quantity ?? 1); n += 1) units.push(item.unitPriceMinor);
    unitsByType.set(item.ticketTypeId as string, units);
  }
  const itemsGrossMinor = ticketItems.reduce((s, i) => s + i.unitPriceMinor * (i.quantity ?? 1), 0);

  const subtotal = booking.subtotalMinor ?? 0;
  const discount = Math.min(Math.max(0, booking.discountMinor ?? 0), Math.max(0, subtotal));
  const scale = (grossMinor: number) =>
    subtotal > 0 && discount > 0
      ? Math.round((grossMinor * (subtotal - discount)) / subtotal)
      : grossMinor;

  const netByTicket = new Map<string, number>();
  const dealt = new Map<string, number>();
  let cumulativeGross = 0;
  let cumulativeNet = 0;
  for (const ticket of [...tickets].sort(byId)) {
    const units = unitsByType.get(ticket.ticketTypeId) ?? [];
    const index = dealt.get(ticket.ticketTypeId) ?? 0;
    dealt.set(ticket.ticketTypeId, index + 1);
    // More tickets than sold units cannot happen for a confirmed booking; if it ever does, the
    // type's last price is used, which is what the lookup by type always returned.
    const gross = units[Math.min(index, units.length - 1)] ?? 0;
    cumulativeGross += gross;
    const next = scale(cumulativeGross);
    netByTicket.set(ticket.id, next - cumulativeNet);
    cumulativeNet = next;
  }

  return { netByTicket, bookingTicketsMinor: scale(itemsGrossMinor) };
}
