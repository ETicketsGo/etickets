import type { TaxRule } from '@prisma/client';
import type { TaxRuleInput } from '../pricing/tax-calculator';

/**
 * A stored `TaxRule` as the calculator reads it.
 *
 * One mapping, used by the manual tax provider that prices a sale and by the readiness check
 * that predicts whether the sale will price. Two copies of it would be two answers to "does
 * this ticket have a rate", and the organizer would be told one and the buyer the other.
 */
export function taxRuleFromRow(r: TaxRule): TaxRuleInput {
  return {
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
  };
}
