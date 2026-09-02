import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { computeTax, type TaxRuleInput } from '../../pricing/tax-calculator';
import type { TaxProvider, TaxQuoteRequest, TaxQuoteResult } from '../tax-provider.interface';

/**
 * Tax from the `TaxRule` table an owner configured.
 *
 * This is the shipped default and it reproduces the platform's existing behaviour exactly:
 * with no active rules — which is how the table starts — it charges nothing and every total
 * is what it was before tax existed in this codebase.
 *
 * Appropriate where the answer really is a rate: a single jurisdiction whose rate an
 * organizer's advisor can state and which changes rarely. That describes the India pilot.
 * It is NOT appropriate for US sales tax, where whether anything is owed depends on nexus
 * thresholds and the rate depends on the buyer's city — see the external provider.
 */
@Injectable()
export class ManualTaxProvider implements TaxProvider {
  readonly name = 'manual';

  constructor(private readonly prisma: PrismaService) {}

  async quote(request: TaxQuoteRequest): Promise<TaxQuoteResult> {
    const currency = request.context.currency;
    const rows = await this.prisma.taxRule.findMany({
      where: { active: true, currency: { in: [currency, '*'] } },
      orderBy: { priority: 'asc' },
    });
    const rules: TaxRuleInput[] = rows.map((r) => ({
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
      taxGroup: r.taxGroup,
      category: r.category,
      minUnitMinor: r.minUnitMinor,
      maxUnitMinor: r.maxUnitMinor,
      inclusive: r.inclusive,
      split: r.split as TaxRuleInput['split'],
    }));

    const { taxLines, taxMinor, taxAddedMinor } = computeTax({
      netSubtotalMinor: request.netSubtotalMinor,
      customerFeeMinor: request.customerFeeMinor,
      admissionLines: request.admissionLines,
      rules,
      place: {
        country: request.context.country,
        region: request.context.region,
        supplierRegion: request.context.supplierRegion,
        currency,
        at: request.context.at,
      },
    });
    return { taxLines, taxMinor, taxAddedMinor, provider: this.name, providerRef: null };
  }
}
