import type { TaxLine } from '../pricing/tax-calculator';

/**
 * The seam between "what tax is owed" and this codebase.
 *
 * ── WHY A SEAM RATHER THAN MORE RULES ──────────────────────────────────────────────
 * US sales tax on admissions varies by state, many cities add their own amusement or
 * admissions tax, and whether anything is owed in a state at all depends on economic-nexus
 * thresholds that move. Encoding that here would mean this repository maintaining a
 * fifty-state rules engine whose errors are charged to real customers, and shipping a
 * release every time a rate changes.
 *
 * So the platform holds the SHAPE of the answer — an itemised set of tax lines on the
 * booking — and lets the source of the answer be swapped. Two sources exist:
 *
 *   `manual`   — the TaxRule table an owner configures. Correct for a single jurisdiction
 *                with a stable rate, which is what an India pilot is. Ships as the default
 *                and, with no rules active, charges nothing.
 *   `external` — a tax service (Stripe Tax, Avalara, TaxJar). Correct for the US, and for
 *                anywhere the answer depends on more than a rate.
 *
 * Both return the same `TaxLine[]`, so the booking, the receipt and the refund path do not
 * know or care which was used. That is the whole point of the seam: choosing a vendor later
 * is a configuration change and an adapter, not a change to the money model.
 */

/** One thing being sold, for providers that need to classify what is taxable. */
export interface TaxableLine {
  /** Stable identifier for the item, echoed back in provider diagnostics. */
  reference: string;
  /** Amount for this line in integer minor units, net of discount. */
  amountMinor: number;
  /**
   * What kind of thing this is, in the platform's own vocabulary — `admission`, `fee`,
   * `merchandise`. Vendor tax codes are the ADAPTER's job to map; putting an Avalara code
   * in the booking engine would bind the whole platform to one vendor's taxonomy.
   */
  kind: 'admission' | 'fee' | 'merchandise';
}

/** Where and when the sale happens. */
export interface TaxQuoteContext {
  currency: string;
  /** Place of supply — the venue's location for an admission. */
  country?: string | null;
  region?: string | null;
  /**
   * Where the SELLER is registered, compared against `region` to decide whether the sale
   * crosses a state border. India splits one rate into CGST + SGST intra-state and charges
   * IGST across one; the amount is identical, the invoice is not.
   */
  supplierRegion?: string | null;
  /**
   * The BUYER's state and the PLATFORM's, for the booking fee.
   *
   * Admission and the platform's fee are different supplies with different place-of-supply
   * rules — s.12(6) for admission, s.12(2) for a service. A real order can carry a locally
   * taxed ticket and an IGST convenience fee at once, which one pair of states cannot express.
   */
  customerRegion?: string | null;
  platformRegion?: string | null;
  postalCode?: string | null;
  at?: Date;
  /** The selling organization, so an adapter can pass the seller's registration through. */
  organizationId?: string | null;
}

export interface TaxQuoteRequest {
  context: TaxQuoteContext;
  /** Ticket subtotal after discount. */
  netSubtotalMinor: number;
  /**
   * The order broken into ticket kinds — unit price and quantity, not a total.
   *
   * Required by any rule with a price band, because a band is written per ticket. Ten
   * ninety-rupee tickets are ten ninety-rupee tickets; rating them off a nine-hundred-rupee
   * order puts every one of them in the wrong band.
   */
  admissionLines?: { unitPriceMinor: number; quantity: number; category?: string | null }[];
  /** The fee the CUSTOMER bears. Organizer-absorbed fees are not the buyer's tax matter. */
  customerFeeMinor: number;
  lines: TaxableLine[];
}

export interface TaxQuoteResult {
  taxLines: TaxLine[];
  taxMinor: number;
  /**
   * The portion to ADD to the total. Inclusive tax is already inside the ticket price and
   * adding it would charge it twice, so the split is returned rather than left to callers.
   */
  taxAddedMinor: number;
  /**
   * Which provider produced this, recorded on the booking's audit trail so a later
   * question about a specific charge can be answered without guessing.
   */
  provider: string;
  /** The vendor's own identifier for the calculation, when it issues one. */
  providerRef?: string | null;
}

export interface TaxProvider {
  readonly name: string;
  quote(request: TaxQuoteRequest): Promise<TaxQuoteResult>;
}

export const TAX_PROVIDER = Symbol('TAX_PROVIDER');
