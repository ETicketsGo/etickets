import { money, type PricingComplianceStatus } from '@eticketsgo/shared-types';
import type { PolicyResolution } from './cinema-pricing-policy.resolver';
import { checkTicketPrice } from './apply-policy';
import { hasNoCeilingFallback } from './sale-eligibility';

/**
 * The price limit for each regulatory seat class at one cinema, in words an exhibitor can use.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────
 * Found walking QA (2026-10-15, Vijayawada). An organizer had to map "Platinum Executive" to a
 * class from a list that said nothing about what each class allows, set a Recliner show to
 * Rs 300 under a Rs 250 limit without a word from the screen, and read "Order: None applies"
 * on the readiness page of a cinema the Andhra Pradesh order plainly covers (it resolves per
 * class, and the panel asked for the whole room at once). Checkout refused all of it
 * correctly; nobody could see why in advance.
 *
 * ── A READING, NEVER A SECOND RULE ─────────────────────────────────────────────────
 * Each class is asked of the same resolver, the same way checkout asks it one class at a time
 * (`resolveCinemaPolicy`), and judged by the same two functions: `hasNoCeilingFallback` for
 * "this class has no rate here" and `checkTicketPrice` for "this price is outside the band".
 * Nothing here can make a price sellable that checkout would refuse.
 */
export const REGULATORY_CLASSES = ['REGULAR', 'RECLINER', 'PREMIUM', 'NON_PREMIUM'] as const;
export type RegulatoryClass = (typeof REGULATORY_CLASSES)[number];

/** Operator-facing class names, the same words as the Seat classes control. */
export const CLASS_LABEL: Record<string, string> = {
  REGULAR: 'Regular',
  RECLINER: 'Recliner',
  PREMIUM: 'Premium',
  NON_PREMIUM: 'Non-premium',
};

export interface ClassCeiling {
  regulatoryClass: RegulatoryClass;
  /** False when no pricing order applies here at all: any price is the organizer's own. */
  regulated: boolean;
  /**
   * False when this place is regulated but has no rate for this class (or no rules at all, as
   * in Telangana): a seat of this class cannot be sold online at any price.
   */
  sellable: boolean;
  /** The most a ticket of this class may cost, when the order states one. */
  maxMinor: number | null;
  /** The least a ticket of this class may cost, when the order states one. */
  minMinor: number | null;
  /** The cited order, never the internal notes. */
  regulatoryReference: string | null;
  status: PricingComplianceStatus;
}

/** Asks the resolver for one class. The caller decides the cinema, currency and date. */
export type ResolveClass = (regulatoryClass: RegulatoryClass) => Promise<PolicyResolution>;

/** One class's limit, from one resolution. */
export function ceilingFrom(
  regulatoryClass: RegulatoryClass,
  resolution: PolicyResolution,
): ClassCeiling {
  const regulated = resolution.status !== 'NOT_REGULATED';
  const policy = resolution.policy;
  // A refused resolution (no rules, conflicting rules) has no policy and sells nothing; the
  // fallback rule that names no class and states no maximum is refused by checkout too.
  const sellable = !regulated || (policy != null && !hasNoCeilingFallback(resolution));
  return {
    regulatoryClass,
    regulated,
    sellable,
    maxMinor: sellable && regulated ? (policy?.ticketPriceMaxMinor ?? null) : null,
    minMinor: sellable && regulated ? (policy?.ticketPriceMinMinor ?? null) : null,
    regulatoryReference: policy?.regulatoryReference ?? null,
    status: resolution.status,
  };
}

/** Every class's limit at one cinema. Four resolver calls; the caller may memoise. */
export async function classCeilings(resolveClass: ResolveClass): Promise<ClassCeiling[]> {
  const out: ClassCeiling[] = [];
  for (const cls of REGULATORY_CLASSES) out.push(ceilingFrom(cls, await resolveClass(cls)));
  return out;
}

/**
 * Why a price for a seat of `regulatoryClass` cannot be sold, or null when it can be.
 *
 * Only a price OUTSIDE a stated band is answered here: whether the class has a rate at all is
 * the seat-class mapping's question, and refusing a price for it would send the organizer to
 * the wrong field. The band test is checkout's own `checkTicketPrice`.
 */
export function priceOutsideBand(
  resolution: PolicyResolution,
  input: {
    regulatoryClass: string;
    seatCategoryName: string;
    priceMinor: number;
    currency: string;
    place: string;
  },
): string | null {
  const ceiling = ceilingFrom(input.regulatoryClass as RegulatoryClass, resolution);
  if (!ceiling.regulated || !ceiling.sellable) return null;
  if (checkTicketPrice(resolution, input.priceMinor).ok) return null;
  const cls = CLASS_LABEL[input.regulatoryClass] ?? input.regulatoryClass;
  const fmt = (m: number) => money(m, input.currency);
  if (ceiling.maxMinor != null && input.priceMinor > ceiling.maxMinor) {
    return (
      `${input.seatCategoryName}: ${input.place} allows at most ${fmt(ceiling.maxMinor)} for a ` +
      `${cls} seat at this cinema, so ${fmt(input.priceMinor)} cannot be sold. ` +
      `Enter ${fmt(ceiling.maxMinor)} or less.`
    );
  }
  if (ceiling.minMinor != null && input.priceMinor < ceiling.minMinor) {
    return (
      `${input.seatCategoryName}: ${input.place} requires at least ${fmt(ceiling.minMinor)} for a ` +
      `${cls} seat at this cinema. Enter ${fmt(ceiling.minMinor)} or more.`
    );
  }
  return null;
}
