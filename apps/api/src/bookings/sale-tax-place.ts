import { effectiveTaxCategory } from '@eticketsgo/shared-types';
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

/**
 * The tax category ONE ticket type is sold under: its own override, else its event's.
 *
 * Never the seat category's `regulatoryClass`. That is a cinema PRICING class (REGULAR,
 * RECLINER...) a state rate order bands on, and it was what the tax engine used to receive as
 * the category - so the India rules written for cinema never matched a cinema ticket and every
 * one fell to the 18% catch-all. Null when nobody has classified it; a market whose tax depends
 * on the classification refuses such a sale instead of guessing.
 */
export function ticketTaxCategory(
  ticketType: { taxCategory?: string | null } | null | undefined,
  event: { taxCategory?: string | null } | null | undefined,
): string | null {
  return effectiveTaxCategory(ticketType?.taxCategory, event?.taxCategory);
}

/**
 * The admission lines the TAX engine rates: the same tickets, categorised by tax category.
 *
 * The booking builds one list for two consumers. The cinema pricing policy reads `category`
 * as the seat class; the tax engine reads `category` as what the ticket is. Mapping here, at
 * the one hand-off to pricing, keeps the two from ever being the same field again.
 */
export function taxAdmissionLines(
  lines: readonly { unitPriceMinor: number; quantity: number; taxCategory: string | null }[],
): { unitPriceMinor: number; quantity: number; category: string | null }[] {
  return lines.map((line) => ({
    unitPriceMinor: line.unitPriceMinor,
    quantity: line.quantity,
    category: line.taxCategory,
  }));
}

/** A booking's stored ticket row, as far as rating it for tax needs. */
export interface PricedTicketItem {
  unitPriceMinor: number;
  quantity: number;
  /** The tax category snapshotted when the booking was made. */
  taxCategory?: string | null;
  ticketType?: { taxCategory?: string | null } | null;
}

/**
 * The admission lines a stored booking was priced with, rebuilt from its ticket rows.
 *
 * Mirrors `BookingsService.admissionLinesFor` + `taxAdmissionLines`, which build them from the
 * cart at `create`: the unit price of one ticket (a rate bands on that, never on the order),
 * the quantity, and the tax category. Read from the booking rather than the live ticket type so
 * a re-price rates what the buyer was quoted, even if the organizer has since changed it. A row
 * from before the snapshot existed falls back to the live classification.
 */
export function admissionLinesFromItems(
  items: readonly PricedTicketItem[],
  event?: { taxCategory?: string | null } | null,
): { unitPriceMinor: number; quantity: number; category: string | null }[] {
  return items
    .filter((item) => item.quantity > 0)
    .map((item) => ({
      unitPriceMinor: item.unitPriceMinor,
      quantity: item.quantity,
      category: item.taxCategory?.trim() || ticketTaxCategory(item.ticketType, event),
    }));
}
