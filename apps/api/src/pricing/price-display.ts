import { FeeMode } from '@eticketsgo/shared-types';
import { calculateFees, type FeeTier } from './fee-calculator';

/**
 * How a price is advertised BEFORE checkout — on a listing card, an event page, a search
 * result.
 *
 * ── WHY THIS IS NOT A CHECKOUT CONCERN ─────────────────────────────────────────────
 * Several US states now require the total price including mandatory fees to be shown
 * upfront, and federal rules have moved the same way. The word that matters is *upfront*:
 * the requirement is about the number a buyer sees when they are deciding, not the
 * breakdown they see once they have decided. A platform that itemises correctly at
 * checkout and advertises a bare ticket price on the listing has complied with nothing.
 *
 * So this is a display MODE that changes what the listing endpoints return, and the
 * checkout breakdown is unaffected either way — a buyer still sees exactly what they are
 * paying for, because an all-in headline that cannot be broken down is its own problem.
 *
 *   `itemised` (default) — advertise the ticket face price. Fees appear at checkout.
 *   `all_in`             — advertise ticket + mandatory customer-borne fees.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DECIDE ─────────────────────────────────────────
 * Which mode a market requires. That is a question for the owner and their counsel, it
 * differs by state, and it is moving. The platform's job is to be able to do either
 * faithfully, and to make the choice a single explicit setting rather than something
 * scattered across a dozen templates.
 *
 * Tax is NOT included even in `all_in`. Tax is not a fee the seller sets — it depends on
 * the buyer's location, which is unknown while they are browsing, and quoting a
 * jurisdiction's tax to somebody in a different one would be worse than omitting it.
 * Where a market requires tax-inclusive display, that is a tax-service question and is
 * handled through the tax provider seam, not by guessing here.
 */
export type PriceDisplayMode = 'itemised' | 'all_in';

export const DEFAULT_PRICE_DISPLAY_MODE: PriceDisplayMode = 'itemised';

export interface AdvertisedPriceInput {
  /** The ticket's face price, in integer minor units. */
  basePriceMinor: number;
  mode: PriceDisplayMode;
  /** How fees are borne for this event. Only CUSTOMER_PAYS and SHARED reach the buyer. */
  feeMode: FeeMode;
  tiers?: FeeTier[];
  paymentFeeBps?: number;
  currency?: string;
}

/**
 * The number to advertise for one ticket.
 *
 * Computed for a SINGLE ticket, because that is what "from £X" means and because booking
 * fees are tiered on order value — advertising a per-ticket share of a multi-ticket order's
 * fee would be a number no buyer could ever be charged.
 */
export function advertisedPriceMinor(input: AdvertisedPriceInput): number {
  if (input.mode !== 'all_in') return input.basePriceMinor;
  if (input.basePriceMinor <= 0) return input.basePriceMinor;

  const quote = calculateFees({
    subtotalMinor: input.basePriceMinor,
    feeMode: input.feeMode,
    tiers: input.tiers,
    paymentFeeBps: input.paymentFeeBps,
    currency: input.currency,
  });
  // `totalMinor` is net subtotal + the customer's share of fees, with no tax configured.
  // Fees the ORGANIZER absorbs are excluded automatically, which is correct: they are not
  // mandatory charges to the buyer and including them would overstate the price.
  return quote.totalMinor;
}

/** Parse the configured mode, refusing an unrecognised value rather than guessing. */
export function parsePriceDisplayMode(raw: string | undefined): PriceDisplayMode {
  if (raw === undefined || raw === '') return DEFAULT_PRICE_DISPLAY_MODE;
  if (raw === 'itemised' || raw === 'all_in') return raw;
  throw new Error(
    `Unknown PRICE_DISPLAY_MODE '${raw}'. Use 'itemised' or 'all_in'. ` +
      `Defaulting would advertise the wrong price in whichever market this is set for.`,
  );
}
