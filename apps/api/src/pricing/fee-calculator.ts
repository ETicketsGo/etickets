import { FeeMode } from '@eticketsgo/shared-types';

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
  /** Amount charged to the customer. */
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

  return {
    currency: input.currency ?? 'INR',
    subtotalMinor,
    discountMinor,
    netSubtotalMinor,
    bookingFeeMinor,
    paymentFeeMinor,
    customerFeeMinor,
    organizerFeeMinor,
    totalMinor: netSubtotalMinor + customerFeeMinor,
  };
}
