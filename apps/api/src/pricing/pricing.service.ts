import { Injectable } from '@nestjs/common';
import type { FeeMode } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import {
  calculateFees,
  DEFAULT_FEE_TIERS,
  type FeeCalcResult,
  type FeeTier,
} from './fee-calculator';
import type { TaxPlace, TaxRuleInput } from './tax-calculator';

@Injectable()
export class PricingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Active fee tiers for one currency, cheapest band first.
   *
   * Filtering by currency is load-bearing, not tidiness. Fee amounts are integer MINOR
   * units, so a ₹5 booking fee and a $5 booking fee are stored as 500 each while meaning
   * entirely different sums, and the bands (₹0–₹199 vs $0–$1.99) do not correspond at all.
   * Before multi-currency rules existed this query returned every active rule regardless of
   * currency, which was harmless only because the table held nothing but INR. The moment
   * USD/CAD/AUD rows are seeded, an unfiltered query would interleave four currencies'
   * bands and charge whichever happened to match the subtotal first.
   *
   * Falls back to the built-in India defaults when a currency has no configured rules, which
   * preserves the previous behaviour for an empty table.
   */
  private async loadTiers(currency: string): Promise<FeeTier[]> {
    const rules = await this.prisma.feeRule.findMany({
      where: { active: true, currency },
      orderBy: { minMinor: 'asc' },
    });
    if (rules.length === 0) return DEFAULT_FEE_TIERS;
    return rules.map((r) => ({ minMinor: r.minMinor, maxMinor: r.maxMinor, feeMinor: r.feeMinor }));
  }

  /**
   * Active tax rules that could apply to this sale.
   *
   * Queries only `active: true`, and the column defaults to FALSE — so an untouched
   * installation returns nothing here and charges no tax. Rate matching by country/region
   * happens in the pure calculator; this query casts a slightly wider net (wildcards live
   * in the same column as real values) and lets `selectTaxRules` do the precise work.
   */
  private async loadTaxRules(currency: string): Promise<TaxRuleInput[]> {
    const rules = await this.prisma.taxRule.findMany({
      where: { active: true, currency: { in: [currency, '*'] } },
      orderBy: { priority: 'asc' },
    });
    return rules.map((r) => ({
      label: r.label,
      rateBasisPoints: r.rateBasisPoints,
      appliesTo: r.appliesTo as TaxRuleInput['appliesTo'],
      country: r.country,
      region: r.region,
      currency: r.currency,
      priority: r.priority,
      active: r.active,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
    }));
  }

  /**
   * Compute fees (and any configured tax) for a quote using the currently active DB rules
   * for `currency`. Defaults to INR so existing callers that do not pass one behave exactly
   * as before — and with no tax rules configured, the result is identical to before tax
   * existed in this codebase.
   */
  async quote(
    subtotalMinor: number,
    feeMode: FeeMode,
    discountMinor = 0,
    currency = 'INR',
    taxPlace: TaxPlace = {},
  ): Promise<FeeCalcResult> {
    const [tiers, taxRules] = await Promise.all([
      this.loadTiers(currency),
      this.loadTaxRules(currency),
    ]);
    return calculateFees({
      subtotalMinor,
      feeMode,
      discountMinor,
      tiers,
      currency,
      taxRules,
      taxPlace,
    });
  }
}
