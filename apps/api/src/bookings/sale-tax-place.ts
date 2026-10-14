import type { TaxPlace } from '../pricing/tax-calculator';

/** The parts of an event that decide where a sale of it happens, for tax. */
export interface TaxPlaceEvent {
  venue?: { country?: string | null; region?: string | null } | null;
  organization?: { registeredCountry?: string | null; registeredRegion?: string | null } | null;
}

/**
 * Where a sale happens, for tax: the ONE derivation the quote, the booking and a re-price use.
 *
 * ── WHY ONE FUNCTION ──────────────────────────────────────────────────────────────────
 * It was written out three times in `BookingsService` - quote, create and coupon re-price -
 * and the three copies had to be kept identical by hand. A quote and the booking that follows
 * it disagreeing about any field below is a price shown and a different price charged, or the
 * same price filed under the wrong government on the invoice.
 *
 * ── THE FIELDS ───────────────────────────────────────────────────────────────────────
 * `region` is the PLACE OF SUPPLY of the admission - where the event is HELD, s.12(6) of
 * India's IGST Act - and `supplierRegion` is where the seller is registered; comparing the two
 * decides CGST + SGST against IGST on the ticket. The organization's address stands in only
 * for an event with no venue on file.
 *
 * `customerRegion` is where the BUYER is, which decides the split on the platform's fee
 * (s.12(2): the recipient's location). Blank means unknown, which the engine treats as
 * intra-state. Since the tax on a levy is computed once and only then split (see
 * `splitTaxAmount`), it changes headings on the invoice and never the amount.
 */
export function saleTaxPlace(
  event: TaxPlaceEvent,
  buyerRegion: string | null | undefined,
  at: Date,
): TaxPlace {
  return {
    country: event.venue?.country ?? event.organization?.registeredCountry ?? null,
    region: event.venue?.region ?? event.organization?.registeredRegion ?? null,
    supplierRegion: event.organization?.registeredRegion ?? null,
    customerRegion: buyerRegion?.trim() || null,
    at,
  };
}

/** A booking's stored ticket row, as far as rating it for tax needs. */
export interface PricedTicketItem {
  unitPriceMinor: number;
  quantity: number;
  ticketType?: { seatCategory?: { regulatoryClass: string | null } | null } | null;
}

/**
 * The admission lines a stored booking was priced with, rebuilt from its ticket rows.
 *
 * Mirrors `BookingsService.admissionLinesFor`, which builds them from the cart at `create`:
 * the unit price of one ticket (a rate bands on that, never on the order), the quantity, and
 * the seat category's regulatory class. Read from the booking rather than the live ticket type
 * so a re-price rates what the buyer was quoted, even if the organizer has since changed it.
 */
export function admissionLinesFromItems(
  items: readonly PricedTicketItem[],
): { unitPriceMinor: number; quantity: number; category: string | null }[] {
  return items
    .filter((item) => item.quantity > 0)
    .map((item) => ({
      unitPriceMinor: item.unitPriceMinor,
      quantity: item.quantity,
      category: item.ticketType?.seatCategory?.regulatoryClass ?? null,
    }));
}
