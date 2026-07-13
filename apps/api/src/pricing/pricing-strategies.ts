import { Injectable } from '@nestjs/common';
import { PricingStrategyKind } from '@eticketsgo/shared-types';
import type {
  PricingContext,
  PricingLineInput,
  PricingQuote,
  PricingStrategy,
} from './pricing-strategy.interface';

/**
 * Shared base: prices each line by its resolved unit price and sums the subtotal.
 * Concrete strategies differ in how they resolve/validate the unit price. All of
 * them return the ticket type's face price for the current data, so the platform's
 * original subtotal is reproduced exactly (backward compatible). See ADR-019.
 */
abstract class BasePricingStrategy implements PricingStrategy {
  abstract readonly kind: PricingStrategyKind;
  protected abstract unitPriceFor(line: PricingLineInput, ctx: PricingContext): number;

  quote(ctx: PricingContext): PricingQuote {
    const lines = ctx.lines.map((line) => {
      const unitPriceMinor = this.unitPriceFor(line, ctx);
      return {
        ticketTypeId: line.ticketTypeId,
        quantity: line.quantity,
        unitPriceMinor,
        lineTotalMinor: unitPriceMinor * line.quantity,
      };
    });
    return {
      kind: this.kind,
      lines,
      subtotalMinor: lines.reduce((s, l) => s + l.lineTotalMinor, 0),
      appliedRules: [],
    };
  }
}

/** One uniform price per line (degenerate single-tier case). */
@Injectable()
export class FlatPricingStrategy extends BasePricingStrategy {
  readonly kind = PricingStrategyKind.FLAT;
  protected unitPriceFor(line: PricingLineInput): number {
    return line.basePriceMinor;
  }
}

/** Events: price per ticket-type tier (the ticket type's face price). */
@Injectable()
export class TierPricingStrategy extends BasePricingStrategy {
  readonly kind = PricingStrategyKind.TIER;
  protected unitPriceFor(line: PricingLineInput): number {
    return line.basePriceMinor;
  }
}

/** Movies: price per seat category. Seat-priced lines must map to a category. */
@Injectable()
export class SeatPricingStrategy extends BasePricingStrategy {
  readonly kind = PricingStrategyKind.SEAT;
  protected unitPriceFor(line: PricingLineInput): number {
    // The seat category's ticket type carries the price; the booking engine has
    // already validated that each selected seat matches this category.
    return line.basePriceMinor;
  }
}
