import { Injectable } from '@nestjs/common';
import { PricingStrategyKind } from '@eticketsgo/shared-types';
import {
  FlatPricingStrategy,
  SeatPricingStrategy,
  TierPricingStrategy,
} from './pricing-strategies';
import type {
  PricingContext,
  PricingQuote,
  PricingRule,
  PricingStrategy,
} from './pricing-strategy.interface';

/**
 * Resolves the pricing strategy for an experience and produces a quote, applying
 * any configured rules on top of the base prices. The booking engine depends only
 * on this service.
 *
 * Backward compatibility: events resolve to TIER and movies to SEAT, both of which
 * return the ticket type's face price; `rulesFor()` returns an empty list by
 * default, so the subtotal is byte-for-byte identical to the platform's original
 * pricing. Rules are opt-in per experience (a future pricing-config feature). See
 * ADR-019.
 */
@Injectable()
export class PricingStrategiesService {
  private readonly byKind: Record<string, PricingStrategy>;

  constructor(flat: FlatPricingStrategy, tier: TierPricingStrategy, seat: SeatPricingStrategy) {
    this.byKind = {
      [PricingStrategyKind.FLAT]: flat,
      [PricingStrategyKind.TIER]: tier,
      [PricingStrategyKind.SEAT]: seat,
    };
  }

  /**
   * The base pricing strategy for a booking, by whether it names seats.
   *
   * SEAT pricing takes its price from the seat's category — a stalls seat and a balcony seat
   * cost different amounts in the same room. TIER pricing takes it from the ticket type.
   * Which applies follows the room, not the kind of event, for the same reason the inventory
   * strategy does.
   */
  forSeating(seatBased: boolean): PricingStrategy {
    return this.byKind[seatBased ? PricingStrategyKind.SEAT : PricingStrategyKind.TIER];
  }

  /**
   * Rules to apply for this booking context. Default: none (preserving current
   * prices). A future per-experience pricing configuration populates this; that is
   * the only place new rules become active.
   */
  private rulesFor(_ctx: PricingContext): PricingRule[] {
    return [];
  }

  /** Price a booking: base strategy, then any applicable rules, per line. */
  quote(ctx: PricingContext): PricingQuote {
    const base = this.forSeating(ctx.seatBased).quote(ctx);
    const rules = this.rulesFor(ctx);
    if (rules.length === 0) return base;

    const applied = new Set<PricingRule['kind']>();
    const lines = base.lines.map((line, i) => {
      const input = ctx.lines[i];
      let unit = line.unitPriceMinor;
      for (const rule of rules) {
        if (rule.applies(ctx, input)) {
          unit = rule.adjust(unit, ctx, input);
          applied.add(rule.kind);
        }
      }
      return { ...line, unitPriceMinor: unit, lineTotalMinor: unit * line.quantity };
    });
    return {
      kind: base.kind,
      lines,
      subtotalMinor: lines.reduce((s, l) => s + l.lineTotalMinor, 0),
      appliedRules: [...applied],
    };
  }
}
