/** Coupon discount type (mirrors the Prisma `CouponType` enum values). */
export type CouponType = 'PERCENT' | 'FIXED';

/**
 * The single source of truth for coupon discount math (percent or fixed),
 * capped at the subtotal. Extracted from BookingsService so pricing math lives in
 * one place; behaviour is identical to the original inline calculation. See ADR-019.
 */
export function computeCouponDiscountMinor(
  type: CouponType,
  value: number,
  subtotalMinor: number,
): number {
  const raw = type === 'PERCENT' ? Math.round((subtotalMinor * value) / 100) : value;
  return Math.min(subtotalMinor, raw);
}
