import { Injectable } from '@nestjs/common';
import type { FeeMode } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import {
  calculateFees,
  DEFAULT_FEE_TIERS,
  type FeeCalcResult,
  type FeeTier,
} from './fee-calculator';

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
   * Compute fees for a quote using the currently active DB fee rules for `currency`.
   * Defaults to INR so existing callers that do not pass one behave exactly as before.
   */
  async quote(
    subtotalMinor: number,
    feeMode: FeeMode,
    discountMinor = 0,
    currency = 'INR',
  ): Promise<FeeCalcResult> {
    const tiers = await this.loadTiers(currency);
    return calculateFees({ subtotalMinor, feeMode, discountMinor, tiers, currency });
  }
}
