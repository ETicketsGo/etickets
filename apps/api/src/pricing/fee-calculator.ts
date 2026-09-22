import { countryMatches, FeeMode, type MaintenanceTreatment } from '@eticketsgo/shared-types';
import { computeTax, type TaxLine, type TaxPlace, type TaxRuleInput } from './tax-calculator';

/** How a band charges: a fixed amount, or a share of the order. */
export type FeeTierType = 'FLAT' | 'PERCENT';

/** A tiered platform booking-fee rule. All money in minor units (paise). */
export interface FeeTier {
  minMinor: number;
  /** Inclusive upper bound; null means "and above". */
  maxMinor: number | null;
  /** FLAT: the fee. PERCENT: unused. */
  feeMinor: number;
  /** Omitted means FLAT, so every band written before percentages behaves exactly as before. */
  type?: FeeTierType;
  /** PERCENT: the share of the order in basis points (500 = 5%). */
  percentBps?: number | null;
  /** PERCENT, optional: the least this band charges. */
  minFeeMinor?: number | null;
  /** PERCENT, optional: the most this band charges. */
  maxFeeMinor?: number | null;
}

/**
 * A stored fee rule as a band, in one place.
 *
 * Two loaders turn rows into bands - live pricing and the advertised "from" price - and each
 * used to copy three fields by hand. A new field added to one and forgotten in the other would
 * make the card and the checkout charge differently for the same ticket, so both use this.
 */
export function feeTierFromRule(rule: {
  minMinor: number;
  maxMinor: number | null;
  feeMinor: number;
  feeType?: FeeTierType | string | null;
  feePercentBps?: number | null;
  minFeeMinor?: number | null;
  maxFeeMinor?: number | null;
}): FeeTier {
  return {
    minMinor: rule.minMinor,
    maxMinor: rule.maxMinor,
    feeMinor: rule.feeMinor,
    type: rule.feeType === 'PERCENT' ? 'PERCENT' : 'FLAT',
    percentBps: rule.feePercentBps ?? null,
    minFeeMinor: rule.minFeeMinor ?? null,
    maxFeeMinor: rule.maxFeeMinor ?? null,
  };
}

/**
 * What one band charges on an order of `amountMinor`.
 *
 * FLAT returns its amount, exactly as every band did before percentages existed.
 *
 * PERCENT takes its share of the order, rounded to the nearest minor unit (half up), then held
 * between the band's floor and ceiling when it has them. Rounded once, on the whole order, and
 * never per ticket: rounding each ticket and adding them up drifts from the rate the admin set.
 * The floor is applied before the ceiling, so a band misconfigured with floor above ceiling
 * still charges no more than its ceiling - money the customer is told is the most, is the most.
 */
export function feeForTier(tier: FeeTier, amountMinor: number): number {
  if (tier.type !== 'PERCENT') return tier.feeMinor;
  let fee = Math.round((Math.max(0, amountMinor) * Math.max(0, tier.percentBps ?? 0)) / 10_000);
  if (tier.minFeeMinor != null) fee = Math.max(fee, tier.minFeeMinor);
  if (tier.maxFeeMinor != null) fee = Math.min(fee, tier.maxFeeMinor);
  return fee;
}

/** Where a sale happens, as a fee band is scoped: the VENUE's country and region. */
export interface FeePlace {
  country?: string | null;
  region?: string | null;
}

/** A stored band's scope, as both fee loaders read it. */
export interface ScopedRule extends FeePlace {
  country: string;
  region: string;
  minMinor: number;
}

/** '*' (or blank) is "anywhere"; anything else must equal the place, ignoring case. */
function scopeMatches(ruleValue: string, actual: string | null | undefined): boolean {
  const value = (ruleValue ?? '*').trim();
  if (value === '*' || value === '') return true;
  if (actual == null || actual.trim() === '') return false;
  return value.toUpperCase() === actual.trim().toUpperCase();
}

/**
 * The same test for a country, in any spelling.
 *
 * A band is scoped from a dropdown of market names ("India"), and a venue's country is free
 * text that has been "IN", "india" and "Bharat" in this database. A fee that applies or does
 * not depending on how somebody typed a country is a fee nobody can predict.
 */
function countryScopeMatches(ruleValue: string, actual: string | null | undefined): boolean {
  const value = (ruleValue ?? '*').trim();
  if (value === '*' || value === '') return true;
  if (actual == null || actual.trim() === '') return false;
  return countryMatches(actual, value);
}

/** A named region counts for more than a named country, which counts for more than '*'. */
function specificity(rule: { country: string; region: string }): number {
  return (rule.region !== '*' ? 2 : 0) + (rule.country !== '*' ? 1 : 0);
}

/**
 * The bands that apply where a sale happens, most specific first.
 *
 * ── WHY SPECIFICITY IS PER BAND AND NOT PER SET ────────────────────────────────────
 * This used to keep ONLY the most specific bands and throw the rest away, so the winning
 * scope replaced a broader schedule wholesale. It looked tidy and it mispriced real money:
 * on QA the INR schedule was four national bands plus two India-scoped ones, and the two
 * shadowed the four. An order of Rs 700 had no band left to match, fell through to the last
 * band in the list - "3% of the order above Rs 2,000" - and was charged Rs 21 instead of the
 * Rs 15 the admin console displayed.
 *
 * Adding one band for one place is the normal way an admin works, and it must not silently
 * delete the schedule around it. So specificity decides WHICH band wins for an amount both
 * cover, and ranges nobody covered more narrowly keep the broader band. Sorted most specific
 * first and `resolveBookingFee` takes the first match, which is exactly that rule.
 */
export function applicableTiers<T extends ScopedRule>(rules: T[], place: FeePlace = {}): T[] {
  return rules
    .filter(
      (r) => countryScopeMatches(r.country, place.country) && scopeMatches(r.region, place.region),
    )
    .sort((a, b) => specificity(b) - specificity(a) || a.minMinor - b.minMinor);
}

/** India seed defaults (section 13). Subtotal-tiered booking fee. */
export const DEFAULT_FEE_TIERS: FeeTier[] = [
  { minMinor: 0, maxMinor: 19_900, feeMinor: 500 }, // ₹0–₹199 -> ₹5
  { minMinor: 20_000, maxMinor: 49_900, feeMinor: 1_000 }, // ₹200–₹499 -> ₹10
  { minMinor: 50_000, maxMinor: 99_900, feeMinor: 1_500 }, // ₹500–₹999 -> ₹15
  { minMinor: 100_000, maxMinor: null, feeMinor: 2_000 }, // ₹1000+ -> ₹20 max
];

/** Mock payment processing fee in basis points (2%). */
export const DEFAULT_PAYMENT_FEE_BPS = 200;

export interface FeeCalcInput {
  subtotalMinor: number;
  feeMode: FeeMode;
  discountMinor?: number;
  tiers?: FeeTier[];
  paymentFeeBps?: number;
  /** ISO 4217 currency; flows through to the result. Defaults to INR (seed market). */
  currency?: string;
  /**
   * Tax rules to apply, already loaded from configuration. Omitted or empty means no tax,
   * which is the shipped default — see tax-calculator.ts for why nothing is assumed.
   */
  taxRules?: TaxRuleInput[];
  /** Where/when the sale happens, for matching those rules. */
  taxPlace?: TaxPlace;
}

export interface FeeCalcResult {
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  /** Net of discount — the amount fees are computed on. */
  netSubtotalMinor: number;
  bookingFeeMinor: number;
  paymentFeeMinor: number;
  /** Fee amount the customer pays on top of the net subtotal. */
  customerFeeMinor: number;
  /** Fee amount the organizer absorbs. */
  organizerFeeMinor: number;
  /** Itemised tax, one entry per applicable rule. Empty unless tax is configured. */
  taxLines: TaxLine[];
  /**
   * The platform fee ALL-IN — what it actually costs the customer, tax included.
   *
   * One number rather than two, because "what does this platform charge me" has one answer
   * and neither ₹40.00 nor ₹7.20 is it. Equal to `customerFeeMinor` when the fee's tax was
   * already inside it.
   */
  customerFeeInclusiveMinor?: number;
  /** The combined rate inside that figure — 1800 for an 18% GST, 0 when untaxed. */
  feeTaxRateBasisPoints?: number;
  /** The tax component of the all-in fee. */
  feeTaxMinor?: number;
  /** Total tax the customer pays, the sum of `taxLines`. Zero unless tax is configured. */
  taxMinor: number;
  /**
   * A statutory per-ticket maintenance charge for the whole order, if a jurisdiction's
   * cinema pricing order imposes one. Zero everywhere else.
   *
   * Reported separately from the subtotal and from the fees, and never folded into either:
   * platform-revenue reporting sums the fee columns, and a statutory charge counted as
   * ETicketsGo income would misstate revenue.
   */
  maintenanceMinor?: number;
  /** Whether that amount is already inside the ticket price or was added to the total. */
  maintenanceTreatment?: MaintenanceTreatment;
  /** Amount charged to the customer, tax included. */
  totalMinor: number;
}

/**
 * What the configured bands charge on this amount.
 *
 * First match wins, and the caller orders the bands so the most specific scope is tried
 * first. When nothing matches - a schedule with a hole in it - the NEAREST band by amount is
 * used: the highest band that starts at or below this order, or the lowest band when the
 * order is smaller than every band.
 *
 * It used to take the last band in the list instead, which was the largest band only while
 * the list happened to be sorted by amount. Once bands are ordered by scope it is not, and
 * "last in the list" charged a Rs 100 order under a band written for orders above Rs 2,000.
 */
function resolveBookingFee(amountMinor: number, tiers: FeeTier[]): number {
  for (const tier of tiers) {
    const underMax = tier.maxMinor === null || amountMinor <= tier.maxMinor;
    if (amountMinor >= tier.minMinor && underMax) return feeForTier(tier, amountMinor);
  }
  if (!tiers.length) return 0;
  const atOrBelow = tiers.filter((t) => t.minMinor <= amountMinor);
  const nearest = atOrBelow.length
    ? atOrBelow.reduce((best, t) => (t.minMinor > best.minMinor ? t : best))
    : tiers.reduce((best, t) => (t.minMinor < best.minMinor ? t : best));
  return feeForTier(nearest, amountMinor);
}

/**
 * Pure fee calculation. Deterministic and side-effect free so it can be unit
 * tested and reused for both live pricing and historical booking snapshots.
 */
export function calculateFees(input: FeeCalcInput): FeeCalcResult {
  const tiers = input.tiers ?? DEFAULT_FEE_TIERS;
  const bps = input.paymentFeeBps ?? DEFAULT_PAYMENT_FEE_BPS;
  const subtotalMinor = Math.max(0, Math.round(input.subtotalMinor));
  const discountMinor = Math.min(subtotalMinor, Math.max(0, Math.round(input.discountMinor ?? 0)));
  const netSubtotalMinor = subtotalMinor - discountMinor;

  const bookingFeeMinor = netSubtotalMinor === 0 ? 0 : resolveBookingFee(netSubtotalMinor, tiers);
  const paymentFeeMinor = Math.round((bps * (netSubtotalMinor + bookingFeeMinor)) / 10_000);
  const totalFees = bookingFeeMinor + paymentFeeMinor;

  let customerFeeMinor = 0;
  let organizerFeeMinor = 0;
  switch (input.feeMode) {
    case FeeMode.CUSTOMER_PAYS:
      customerFeeMinor = totalFees;
      break;
    case FeeMode.ORGANIZER_PAYS:
      organizerFeeMinor = totalFees;
      break;
    case FeeMode.SHARED:
      customerFeeMinor = Math.ceil(totalFees / 2);
      organizerFeeMinor = totalFees - customerFeeMinor;
      break;
  }

  // Tax comes last because it is levied on what the customer is actually charged: the
  // discounted ticket price plus whatever share of the fees they bear. Computing it earlier
  // would tax money the customer never pays.
  const { taxLines, taxMinor } = computeTax({
    netSubtotalMinor,
    customerFeeMinor,
    rules: input.taxRules ?? [],
    place: { currency: input.currency ?? 'INR', ...(input.taxPlace ?? {}) },
  });

  return {
    currency: input.currency ?? 'INR',
    subtotalMinor,
    discountMinor,
    netSubtotalMinor,
    bookingFeeMinor,
    paymentFeeMinor,
    customerFeeMinor,
    organizerFeeMinor,
    taxLines,
    taxMinor,
    totalMinor: netSubtotalMinor + customerFeeMinor + taxMinor,
  };
}
