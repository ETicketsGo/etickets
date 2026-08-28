import type {
  ExperienceType,
  PricingRuleKind,
  PricingStrategyKind,
} from '@eticketsgo/shared-types';

/** One line to price: N units of a ticket type at its face (base) price. */
export interface PricingLineInput {
  ticketTypeId: string;
  quantity: number;
  basePriceMinor: number;
  seatCategoryId?: string | null;
}

/** Everything a strategy/rule needs to price a booking — no DB access inside. */
export interface PricingContext {
  experienceType: ExperienceType;
  /**
   * Whether the lines name seats. Decides SEAT pricing (price from the seat's category)
   * over TIER pricing (price from the ticket type) — a property of the room, not of the
   * kind of event, which is why it is passed rather than inferred from `experienceType`.
   */
  seatBased: boolean;
  sessionStartsAt: Date;
  now: Date;
  isMember?: boolean;
  lines: PricingLineInput[];
}

export interface PricedLine {
  ticketTypeId: string;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
}

export interface PricingQuote {
  kind: PricingStrategyKind;
  lines: PricedLine[];
  subtotalMinor: number;
  /** Rule kinds that adjusted the base prices (empty when none applied). */
  appliedRules: PricingRuleKind[];
}

/**
 * Computes the per-line unit price for a booking. Base strategies resolve the
 * price; a strategy may apply a set of {@link PricingRule}s on top. The booking
 * engine depends only on this interface. See ADR-019.
 */
export interface PricingStrategy {
  readonly kind: PricingStrategyKind;
  /** Full price quote for the context (calculate + preview share this). */
  quote(ctx: PricingContext): PricingQuote;
}

/**
 * A composable price adjustment (surcharge/discount) applied to a base unit
 * price. Rules are pure and side-effect free so they are trivially testable and
 * order-independent per line.
 */
export interface PricingRule {
  readonly kind: PricingRuleKind;
  /** Whether this rule applies to the given line in the context. */
  applies(ctx: PricingContext, line: PricingLineInput): boolean;
  /** Return the adjusted unit price (minor units), never negative. */
  adjust(unitPriceMinor: number, ctx: PricingContext, line: PricingLineInput): number;
}

/** Clamp helper shared by rules — money is never negative. */
export function clampMinor(value: number): number {
  return Math.max(0, Math.round(value));
}
