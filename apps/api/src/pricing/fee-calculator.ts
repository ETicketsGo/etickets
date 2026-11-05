import { countryMatches, FeeMode, type MaintenanceTreatment } from '@eticketsgo/shared-types';
import { computeTax, type TaxLine, type TaxPlace, type TaxRuleInput } from './tax-calculator';

/**
 * How a band charges: a fixed amount per order (FLAT), a share of the order (PERCENT), both
 * (COMBINED: a share of the order plus a fixed amount for each paid ticket), or a fixed amount
 * for each paid ticket and nothing else (FIXED_PER_TICKET).
 */
export type FeeTierType = 'FLAT' | 'PERCENT' | 'COMBINED' | 'FIXED_PER_TICKET';

/** A tiered platform booking-fee rule. All money in minor units (paise). */
export interface FeeTier {
  minMinor: number;
  /** Inclusive upper bound; null means "and above". */
  maxMinor: number | null;
  /**
   * FLAT: the fee, once per order. PERCENT: unused. COMBINED: the fixed part, charged once per
   * paid ticket. FIXED_PER_TICKET: the fee for each paid ticket.
   */
  feeMinor: number;
  /** Omitted means FLAT, so every band written before percentages behaves exactly as before. */
  type?: FeeTierType;
  /** PERCENT and COMBINED: the share of the order in basis points (500 = 5%). */
  percentBps?: number | null;
  /**
   * PERCENT, COMBINED and FIXED_PER_TICKET, optional: the least this band charges for the whole
   * order. Null (the default) is no minimum.
   */
  minFeeMinor?: number | null;
  /** The same, the most this band charges for the whole order. Null is no maximum. */
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
    type: tierType(rule.feeType),
    percentBps: rule.feePercentBps ?? null,
    minFeeMinor: rule.minFeeMinor ?? null,
    maxFeeMinor: rule.maxFeeMinor ?? null,
  };
}

/** A stored type as a band type. Anything unknown or missing is FLAT, as every old row was. */
function tierType(t: FeeTierType | string | null | undefined): FeeTierType {
  return t === 'PERCENT' || t === 'COMBINED' || t === 'FIXED_PER_TICKET' ? t : 'FLAT';
}

/** Whether a band type charges per paid ticket (and so explains itself with a breakdown). */
export function isPerTicketType(t: FeeTierType | string | null | undefined): boolean {
  return t === 'COMBINED' || t === 'FIXED_PER_TICKET';
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
export function feeForTier(tier: FeeTier, amountMinor: number, ticketCount = 1): number {
  if (isPerTicketType(tier.type)) {
    return perTicketFeeParts(tier, amountMinor, ticketCount).totalMinor;
  }
  if (tier.type !== 'PERCENT') return tier.feeMinor;
  return applyFeeLimits(percentOf(amountMinor, tier.percentBps), tier).feeMinor;
}

/**
 * Hold a whole-order fee between a band's optional minimum and maximum.
 *
 * The minimum is applied before the maximum, exactly as PERCENT bands always have, so a band
 * misconfigured with minimum above maximum still charges no more than its maximum - the most
 * the customer is told is the most. (The admin console and API refuse that configuration; this
 * is only the order of operations.) `limitApplied` says which limit, if any, changed the fee.
 */
export function applyFeeLimits(
  computedMinor: number,
  limits: Pick<FeeTier, 'minFeeMinor' | 'maxFeeMinor'>,
): { feeMinor: number; limitApplied: 'MIN' | 'MAX' | null } {
  let fee = computedMinor;
  if (limits.minFeeMinor != null) fee = Math.max(fee, limits.minFeeMinor);
  if (limits.maxFeeMinor != null) fee = Math.min(fee, limits.maxFeeMinor);
  return {
    feeMinor: fee,
    limitApplied: fee > computedMinor ? 'MIN' : fee < computedMinor ? 'MAX' : null,
  };
}

/** `bps` basis points of an amount, rounded half up to the nearest minor unit. */
function percentOf(amountMinor: number, bps: number | null | undefined): number {
  return Math.round((Math.max(0, amountMinor) * Math.max(0, bps ?? 0)) / 10_000);
}

/**
 * How a per-ticket fee (COMBINED or FIXED_PER_TICKET) was worked out, as the booking snapshots
 * it.
 *
 * Only present on a result whose booking fee came from such a band or policy, so every order
 * priced any other way returns exactly the shape it always did.
 *
 * The limit fields are present only when the band or policy HAS a minimum or maximum, so a
 * COMBINED fee with none snapshots exactly what it did before limits existed.
 */
export interface PlatformFeeBreakdown {
  type: 'COMBINED' | 'FIXED_PER_TICKET';
  /** COMBINED: the percentage. FIXED_PER_TICKET: always 0. */
  percentBps: number;
  fixedPerTicketMinor: number;
  /** The paid tickets the fixed part was charged on. */
  ticketCount: number;
  /** `percentBps` of the order after discount, rounded half up once. 0 for FIXED_PER_TICKET. */
  percentPartMinor: number;
  /** `fixedPerTicketMinor * ticketCount`. Exact; nothing to round. */
  fixedPartMinor: number;
  /** The configured minimum for the whole order, when there is one. */
  minFeeMinor?: number | null;
  /** The configured maximum for the whole order, when there is one. */
  maxFeeMinor?: number | null;
  /**
   * Which limit changed the fee: 'MIN' raised it, 'MAX' lowered it, null neither. Present
   * whenever a limit is configured. When set, the charged fee is NOT the sum of the parts.
   */
  limitApplied?: 'MIN' | 'MAX' | null;
}

/**
 * A per-ticket band. COMBINED: a share of the order plus a fixed amount per paid ticket.
 * FIXED_PER_TICKET: the fixed amount per paid ticket alone.
 *
 * ── THE ARITHMETIC ─────────────────────────────────────────────────────────────────
 *   fee = round_half_up(order_after_discount * bps / 10000) + fixed * paid_tickets
 *
 * Example (owner's): one Rs 1,000 ticket at 3% + Rs 5 = Rs 30 + Rs 5 = Rs 35 (3500 paise).
 * Three of them = Rs 90 + Rs 15 = Rs 105.
 *
 * ── WHY THE PERCENTAGE IS ROUNDED ONCE, ON THE ORDER ───────────────────────────────
 * The same rule a PERCENT band has always followed. Taking 3% of each ticket and adding them
 * up is the same number before rounding (a percentage of a sum is the sum of the
 * percentages); rounding each ticket separately can only add rounding drift, at most half a
 * minor unit per ticket, and needs the order discount shared out between tickets first. One
 * rounding on the order total is exact to the rate the admin set. Rounding is to the
 * currency's minor unit, because every amount here is already in minor units: paise for INR,
 * cents for USD, yen for JPY.
 *
 * The fixed part is a whole number of minor units times a count, so it never rounds.
 *
 * ── WHAT A "TICKET" IS ─────────────────────────────────────────────────────────────
 * A paid admission: quantity on a line whose unit price is above zero. A free ticket in a mixed
 * cart is not charged the fixed part. An order with nothing to pay is never charged at all
 * (`calculateFees` answers zero before it reads any band).
 *
 * ── FIXED_PER_TICKET ───────────────────────────────────────────────────────────────
 *   fee = fixed * paid_tickets
 * The same per-ticket part with no percentage: Rs 5 per ticket is Rs 15 for three tickets. It is
 * a different type from FLAT, which charges its amount ONCE per order whatever the ticket count
 * (and keeps doing exactly that).
 *
 * ── OPTIONAL MINIMUM AND MAXIMUM (owner decision 2026-10-29) ───────────────────────
 * Both unset by default. When set, they hold the WHOLE-ORDER fee, after the parts are added up
 * (`applyFeeLimits`): "3% + Rs 5 per ticket, at least Rs 20, at most Rs 500". The parts are
 * still reported as computed, and `limitApplied` says the charge differs from their sum.
 */
export function perTicketFeeParts(
  tier: Pick<FeeTier, 'type' | 'feeMinor' | 'percentBps' | 'minFeeMinor' | 'maxFeeMinor'>,
  amountMinor: number,
  ticketCount: number,
): PlatformFeeBreakdown & { totalMinor: number } {
  const type = tier.type === 'FIXED_PER_TICKET' ? 'FIXED_PER_TICKET' : 'COMBINED';
  const tickets = Math.max(0, Math.floor(ticketCount));
  const fixedPerTicketMinor = Math.max(0, tier.feeMinor);
  const percentBps = type === 'COMBINED' ? Math.max(0, tier.percentBps ?? 0) : 0;
  const percentPartMinor = type === 'COMBINED' ? percentOf(amountMinor, percentBps) : 0;
  const fixedPartMinor = fixedPerTicketMinor * tickets;
  const hasLimits = tier.minFeeMinor != null || tier.maxFeeMinor != null;
  const limited = applyFeeLimits(percentPartMinor + fixedPartMinor, tier);
  return {
    type,
    percentBps,
    fixedPerTicketMinor,
    ticketCount: tickets,
    percentPartMinor,
    fixedPartMinor,
    ...(hasLimits
      ? {
          minFeeMinor: tier.minFeeMinor ?? null,
          maxFeeMinor: tier.maxFeeMinor ?? null,
          limitApplied: limited.limitApplied,
        }
      : {}),
    totalMinor: limited.feeMinor,
  };
}

/** A COMBINED band's parts. Kept for callers that name the type; see `perTicketFeeParts`. */
export function combinedFeeParts(
  tier: Pick<FeeTier, 'feeMinor' | 'percentBps' | 'minFeeMinor' | 'maxFeeMinor'>,
  amountMinor: number,
  ticketCount: number,
): PlatformFeeBreakdown & { totalMinor: number } {
  return perTicketFeeParts({ ...tier, type: 'COMBINED' }, amountMinor, ticketCount);
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

/**
 * The tiers that price a sale at `place` from these stored bands, exactly as checkout picks
 * them: the applicable bands most specific first, or the built-in defaults when none apply.
 * Shared by live pricing and the admin's draft-schedule preview, so a preview cannot use a
 * second pricing rule.
 */
export function scheduleTiers(
  rules: (ScopedRule & Parameters<typeof feeTierFromRule>[0])[],
  place: FeePlace = {},
): FeeTier[] {
  const applicable = applicableTiers(rules, place);
  return applicable.length === 0 ? DEFAULT_FEE_TIERS : applicable.map(feeTierFromRule);
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
  /**
   * Paid tickets in the order, for a COMBINED or FIXED_PER_TICKET band's per-ticket part. Every
   * other band type (FLAT included: it is per order) ignores it. Omitted means one, which is what a single-ticket price (the advertised "from"
   * price) is.
   */
  ticketCount?: number;
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
  /**
   * How the booking fee was worked out, when a COMBINED or FIXED_PER_TICKET band or policy set
   * it. Absent for every other fee, so those results are unchanged.
   */
  platformFeeBreakdown?: PlatformFeeBreakdown;
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
function resolveBookingTier(amountMinor: number, tiers: FeeTier[]): FeeTier | null {
  for (const tier of tiers) {
    const underMax = tier.maxMinor === null || amountMinor <= tier.maxMinor;
    if (amountMinor >= tier.minMinor && underMax) return tier;
  }
  if (!tiers.length) return null;
  const atOrBelow = tiers.filter((t) => t.minMinor <= amountMinor);
  return atOrBelow.length
    ? atOrBelow.reduce((best, t) => (t.minMinor > best.minMinor ? t : best))
    : tiers.reduce((best, t) => (t.minMinor < best.minMinor ? t : best));
}

/** The snapshot shape: every part, without the charged total (that is `bookingFeeMinor`). */
function breakdownOf(parts: PlatformFeeBreakdown & { totalMinor: number }): PlatformFeeBreakdown {
  const { totalMinor: _total, ...rest } = parts;
  void _total;
  return rest;
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

  /*
    The band is chosen by the ORDER (its net subtotal), as it always has been, and each type
    charges per order - except the fixed part of COMBINED and FIXED_PER_TICKET, which is per
    paid ticket by definition. A mixed cart therefore falls in one band, chosen by its total,
    and pays that band's terms.
  */
  const tier = netSubtotalMinor === 0 ? null : resolveBookingTier(netSubtotalMinor, tiers);
  const ticketCount = input.ticketCount ?? 1;
  const combined =
    tier && isPerTicketType(tier.type)
      ? perTicketFeeParts(tier, netSubtotalMinor, ticketCount)
      : null;
  const bookingFeeMinor = !tier
    ? 0
    : combined
      ? combined.totalMinor
      : feeForTier(tier, netSubtotalMinor, ticketCount);
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
    ...(combined ? { platformFeeBreakdown: breakdownOf(combined) } : {}),
  };
}
