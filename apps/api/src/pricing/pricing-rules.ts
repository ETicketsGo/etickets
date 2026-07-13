import { PricingRuleKind } from '@eticketsgo/shared-types';
import { clampMinor, type PricingContext, type PricingRule } from './pricing-strategy.interface';

/**
 * Composable price adjustments. These are the pricing extension surface: pure,
 * config-driven, and NOT applied to any existing experience by default (the base
 * strategy runs alone unless an experience opts a rule in), so current prices are
 * unchanged. See ADR-019.
 */

/** Surcharge for shows/sessions that start on a weekend (Sat/Sun). */
export class WeekendPricingRule implements PricingRule {
  readonly kind = PricingRuleKind.WEEKEND;
  constructor(private readonly surchargePct: number) {}
  applies(ctx: PricingContext): boolean {
    const day = ctx.sessionStartsAt.getUTCDay();
    return day === 0 || day === 6;
  }
  adjust(unitPriceMinor: number): number {
    return clampMinor(unitPriceMinor * (1 + this.surchargePct / 100));
  }
}

/** Surcharge for sessions on configured holiday dates (UTC YYYY-MM-DD). */
export class HolidayPricingRule implements PricingRule {
  readonly kind = PricingRuleKind.HOLIDAY;
  constructor(
    private readonly holidays: ReadonlySet<string>,
    private readonly surchargePct: number,
  ) {}
  applies(ctx: PricingContext): boolean {
    return this.holidays.has(ctx.sessionStartsAt.toISOString().slice(0, 10));
  }
  adjust(unitPriceMinor: number): number {
    return clampMinor(unitPriceMinor * (1 + this.surchargePct / 100));
  }
}

/** Discount while booking early (before a cutoff instant). */
export class EarlyBirdPricingRule implements PricingRule {
  readonly kind = PricingRuleKind.EARLY_BIRD;
  constructor(
    private readonly cutoff: Date,
    private readonly discountPct: number,
  ) {}
  applies(ctx: PricingContext): boolean {
    return ctx.now < this.cutoff;
  }
  adjust(unitPriceMinor: number): number {
    return clampMinor(unitPriceMinor * (1 - this.discountPct / 100));
  }
}

/** Discount for members (loyalty/VIP). */
export class MemberPricingRule implements PricingRule {
  readonly kind = PricingRuleKind.MEMBER;
  constructor(private readonly discountPct: number) {}
  applies(ctx: PricingContext): boolean {
    return ctx.isMember === true;
  }
  adjust(unitPriceMinor: number): number {
    return clampMinor(unitPriceMinor * (1 - this.discountPct / 100));
  }
}

/**
 * Demand-based dynamic pricing (feature-flagged: `dynamicPricing`). A real demand
 * model binds here; the default multiplier is 1 (no-op) so enabling the flag alone
 * never changes prices until a model provides a factor. Extension point only.
 */
export class DynamicPricingRule implements PricingRule {
  readonly kind = PricingRuleKind.DYNAMIC;
  constructor(private readonly factor: number = 1) {}
  applies(): boolean {
    return true;
  }
  adjust(unitPriceMinor: number): number {
    return clampMinor(unitPriceMinor * this.factor);
  }
}
