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
 *   ADDED to the price  → the returned tickets' share of the line, out of the line's base:
 *                         the rate re-applied to them, without re-rounding a split half.
 *
 * A line that predates `basis`/`inclusive` is treated as added, exactly as before this
 * change — rows written since 2026-09-06 state both.
 *
 * ── THE ONE CASE WHERE FEE TAX DOES COME BACK ──────────────────────────────────────
 * `includeFeeTax` reverses the first rule, and only a cancellation sets it. When the show is
 * cancelled the buyer gets back everything they paid — fees included — so the tax levied on
 * those fees has to come back with them. Leaving it behind would hand the buyer less than
 * they paid while recording a full refund, which is the same arithmetic fault as the report
 * above, pointing the other way.
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
 * A stretch of the booking's tickets, in minor units, as a cumulative range.
 *
 * The booking's tickets are laid end to end in a fixed order (by id) at what each cost after
 * the discount; a refund returns the stretches its tickets occupy. Every tax line is dealt
 * out over that same line, so ANY grouping of the tickets into refunds returns each line
 * exactly - never a paisa more or less in total.
 */
type Stretch = readonly [from: number, to: number];

/**
 * Each line's share of a set of stretches, rounded on the CUMULATIVE figure.
 *
 * Rounding a share per refund is what made partial refunds drift: three one-ticket refunds of
 * a 10,001-paise line returned 3,334 three times, 10,002 in all. Taking the difference of
 * rounded cumulative amounts instead (as `ticketNetPrices` does for the discount) makes the
 * pieces telescope back to the line.
 */
function taxOverStretches(
  lines: readonly TaxLineSnapshot[],
  stretches: readonly Stretch[],
  bookingTicketsMinor: number,
  options: { includeFeeTax?: boolean },
): RefundTax {
  const out: RefundTaxLine[] = [];
  /** `amount` dealt over `whole`, summed across the stretches; `whole` caps each end. */
  const dealt = (amount: number, whole: number) => {
    if (whole <= 0) return 0;
    const upTo = (x: number) => {
      const clamped = Math.min(Math.max(0, x), whole);
      return clamped >= whole ? amount : Math.round((amount * clamped) / whole);
    };
    return stretches.reduce((sum, [from, to]) => sum + upTo(to) - upTo(from), 0);
  };
  for (const line of lines) {
    if (line.basis === 'FEES' && !options.includeFeeTax) continue;
    /*
      A fee tax line on a cancellation goes back WHOLE, not by the ticket share. The ticket
      share answers "how many of these tickets are being returned"; the fee was charged once
      for the booking and is being returned once, so prorating it by tickets would return a
      fraction of a thing that is not divisible that way.
    */
    if (line.basis === 'FEES') {
      out.push({
        label: line.label,
        rateBasisPoints: line.rateBasisPoints,
        basis: line.basis ?? null,
        inclusive: line.inclusive === true,
        baseMinor: line.baseMinor,
        amountMinor: line.amountMinor,
      });
      continue;
    }
    const common = {
      label: line.label,
      rateBasisPoints: line.rateBasisPoints,
      basis: line.basis ?? null,
    };
    if (line.inclusive === true) {
      // Inside the price: the returned tickets' share of the whole ticket total.
      out.push({
        ...common,
        inclusive: true,
        baseMinor: dealt(line.baseMinor, bookingTicketsMinor),
        amountMinor: dealt(line.amountMinor, bookingTicketsMinor),
      });
    } else {
      /*
        Added to the price: the returned tickets' share of the line, out of the line's own
        base. This used to re-apply the rate to the tickets returned, which is the same
        figure before rounding - but a CGST half now carries the odd paisa of its levy (see
        `splitTaxAmount`), and re-applying 9% to the whole base would not give it back.
        Dealing out the stored amount returns exactly what was charged.
      */
      out.push({
        ...common,
        inclusive: false,
        baseMinor: dealt(line.baseMinor, line.baseMinor),
        amountMinor: dealt(line.amountMinor, line.baseMinor),
      });
    }
  }
  const addedMinor = out.filter((l) => !l.inclusive).reduce((s, l) => s + l.amountMinor, 0);
  const includedMinor = out.filter((l) => l.inclusive).reduce((s, l) => s + l.amountMinor, 0);
  return { addedMinor, includedMinor, taxMinor: addedMinor + includedMinor, lines: out };
}

/**
 * The tax that goes back with an amount of returned tickets, treated as ONE stretch from the
 * start of the booking. Right for a single refund; for refunds that name tickets use
 * `refundTaxForTickets`, which is what makes several partial refunds add up.
 *
 * @param ticketsMinor         the returned tickets at the price they were sold for
 * @param bookingTicketsMinor  every ticket on the booking at that price — the whole an
 *                             inclusive line was levied on, so a partial refund returns its
 *                             share of the line rather than re-deriving a rounded figure
 */
export function refundTax(
  lines: readonly TaxLineSnapshot[],
  ticketsMinor: number,
  bookingTicketsMinor: number,
  options: { includeFeeTax?: boolean } = {},
): RefundTax {
  return taxOverStretches(lines, [[0, Math.max(0, ticketsMinor)]], bookingTicketsMinor, options);
}

/**
 * The tax that goes back with these particular tickets.
 *
 * Each ticket's share of every line is fixed by its place in the booking (tickets in id
 * order, at what they cost after the discount - the order `ticketNetPrices` deals the
 * discount in), not by which refund it happens to be in. So the refund service and the
 * credit note, given the same tickets, compute the same figure; and all of a booking's
 * partial refunds together return each tax line to the paisa.
 *
 * @param netByTicket  from `ticketNetPrices`, for EVERY ticket on the booking
 */
export function refundTaxForTickets(
  lines: readonly TaxLineSnapshot[],
  netByTicket: ReadonlyMap<string, number>,
  ticketIds: readonly string[],
  bookingTicketsMinor: number,
  options: { includeFeeTax?: boolean } = {},
): RefundTax {
  const wanted = new Set(ticketIds);
  const stretches: Stretch[] = [];
  let position = 0;
  for (const id of [...netByTicket.keys()].sort((a, b) => a.localeCompare(b))) {
    const net = netByTicket.get(id) ?? 0;
    if (wanted.has(id)) stretches.push([position, position + net]);
    position += net;
  }
  return taxOverStretches(lines, stretches, bookingTicketsMinor, options);
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
