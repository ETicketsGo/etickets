import { FeeMode } from '@eticketsgo/shared-types';
import { computeTax, type TaxLine, type TaxPlace, type TaxRuleInput } from './tax-calculator';

/** A tiered platform booking-fee rule. All money in minor units (paise). */
export interface FeeTier {
  minMinor: number;
  /** Inclusive upper bound; null means "and above". */
  maxMinor: number | null;
  feeMinor: number;
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
  /** Amount charged to the customer, tax included. */
  totalMinor: number;
}

function resolveBookingFee(amountMinor: number, tiers: FeeTier[]): number {
  for (const tier of tiers) {
    const underMax = tier.maxMinor === null || amountMinor <= tier.maxMinor;
    if (amountMinor >= tier.minMinor && underMax) return tier.feeMinor;
  }
  // Above all tiers -> use the last (highest) tier's fee as the cap.
  return tiers.length ? tiers[tiers.length - 1].feeMinor : 0;
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
