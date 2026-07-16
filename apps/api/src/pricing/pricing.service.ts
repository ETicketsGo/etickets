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

  private async loadTiers(): Promise<FeeTier[]> {
    const rules = await this.prisma.feeRule.findMany({
      where: { active: true },
      orderBy: { minMinor: 'asc' },
    });
    if (rules.length === 0) return DEFAULT_FEE_TIERS;
    return rules.map((r) => ({ minMinor: r.minMinor, maxMinor: r.maxMinor, feeMinor: r.feeMinor }));
  }

  /** Compute fees for a quote using the currently active DB fee rules. */
  async quote(
    subtotalMinor: number,
    feeMode: FeeMode,
    discountMinor = 0,
    currency?: string,
  ): Promise<FeeCalcResult> {
    const tiers = await this.loadTiers();
    return calculateFees({ subtotalMinor, feeMode, discountMinor, tiers, currency });
  }
}
