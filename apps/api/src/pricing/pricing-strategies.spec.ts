import { ExperienceType, PricingStrategyKind } from '@eticketsgo/shared-types';
import {
  FlatPricingStrategy,
  SeatPricingStrategy,
  TierPricingStrategy,
} from './pricing-strategies';
import { PricingStrategiesService } from './pricing-strategies.service';
import {
  DynamicPricingRule,
  EarlyBirdPricingRule,
  HolidayPricingRule,
  MemberPricingRule,
  WeekendPricingRule,
} from './pricing-rules';
import { computeCouponDiscountMinor } from './coupon-pricing';
import type { PricingContext } from './pricing-strategy.interface';

const ctx = (over: Partial<PricingContext> = {}): PricingContext => ({
  experienceType: ExperienceType.EVENT,
  // Seating follows the room now, not the experience type. These cases are all about the
  // rule layer, which does not care either way, so the default is the general-admission one.
  seatBased: false,
  sessionStartsAt: new Date('2026-07-15T12:00:00Z'), // Wednesday
  now: new Date('2026-07-13T00:00:00Z'),
  lines: [
    { ticketTypeId: 't1', quantity: 2, basePriceMinor: 30000 },
    { ticketTypeId: 't2', quantity: 1, basePriceMinor: 50000 },
  ],
  ...over,
});

describe('base pricing strategies (backward compatible)', () => {
  it('TIER/SEAT/FLAT all price each line at its face value → original subtotal', () => {
    for (const s of [
      new TierPricingStrategy(),
      new SeatPricingStrategy(),
      new FlatPricingStrategy(),
    ]) {
      const q = s.quote(ctx());
      expect(q.lines[0].unitPriceMinor).toBe(30000);
      expect(q.lines[0].lineTotalMinor).toBe(60000);
      expect(q.subtotalMinor).toBe(110000); // 2*30000 + 1*50000
      expect(q.appliedRules).toEqual([]);
    }
  });
});

describe('PricingStrategiesService resolver', () => {
  const svc = new PricingStrategiesService(
    new FlatPricingStrategy(),
    new TierPricingStrategy(),
    new SeatPricingStrategy(),
  );
  it('a seated room resolves to SEAT pricing, an unseated one to TIER', () => {
    /*
      This used to read "events resolve to TIER, movies to SEAT", which is precisely the
      conflation that stopped an event from ever having a seat map. A seat price comes from
      the seat's category and a tier price from the ticket type; which applies is a fact
      about the ROOM, and the same concert is seated in a theatre and standing in an arena.
    */
    expect(svc.forSeating(false).kind).toBe(PricingStrategyKind.TIER);
    expect(svc.forSeating(true).kind).toBe(PricingStrategyKind.SEAT);
  });
  it('quote reproduces the original subtotal with no rules applied', () => {
    expect(svc.quote(ctx()).subtotalMinor).toBe(110000);
    expect(svc.quote(ctx({ experienceType: ExperienceType.MOVIE })).subtotalMinor).toBe(110000);
  });
});

describe('pricing rules (opt-in adjustments)', () => {
  const line = { ticketTypeId: 't1', quantity: 1, basePriceMinor: 10000 };

  it('weekend rule surcharges only on weekends', () => {
    const rule = new WeekendPricingRule(20);
    expect(rule.applies(ctx({ sessionStartsAt: new Date('2026-07-18T12:00:00Z') }))).toBe(true); // Sat
    expect(rule.applies(ctx({ sessionStartsAt: new Date('2026-07-15T12:00:00Z') }))).toBe(false); // Wed
    expect(rule.adjust(10000)).toBe(12000);
  });

  it('holiday rule surcharges on configured dates', () => {
    const rule = new HolidayPricingRule(new Set(['2026-12-25']), 50);
    expect(rule.applies(ctx({ sessionStartsAt: new Date('2026-12-25T18:00:00Z') }))).toBe(true);
    expect(rule.applies(ctx({ sessionStartsAt: new Date('2026-12-24T18:00:00Z') }))).toBe(false);
    expect(rule.adjust(10000)).toBe(15000);
  });

  it('early-bird discounts before the cutoff', () => {
    const rule = new EarlyBirdPricingRule(new Date('2026-07-20T00:00:00Z'), 10);
    expect(rule.applies(ctx({ now: new Date('2026-07-13T00:00:00Z') }))).toBe(true);
    expect(rule.applies(ctx({ now: new Date('2026-07-21T00:00:00Z') }))).toBe(false);
    expect(rule.adjust(10000)).toBe(9000);
  });

  it('member rule discounts only for members', () => {
    const rule = new MemberPricingRule(15);
    expect(rule.applies(ctx({ isMember: true }))).toBe(true);
    expect(rule.applies(ctx({ isMember: false }))).toBe(false);
    expect(rule.adjust(10000)).toBe(8500);
  });

  it('dynamic rule is a no-op at factor 1 (flag-gated extension point)', () => {
    expect(new DynamicPricingRule().adjust(10000)).toBe(10000);
    expect(new DynamicPricingRule(1.25).adjust(10000)).toBe(12500);
  });

  it('adjustments never go negative', () => {
    expect(new MemberPricingRule(150).adjust(10000)).toBe(0);
  });

  void line;
});

describe('coupon pricing (centralized math)', () => {
  it('percent and fixed discounts, capped at subtotal', () => {
    expect(computeCouponDiscountMinor('PERCENT', 10, 100000)).toBe(10000);
    expect(computeCouponDiscountMinor('FIXED', 15000, 100000)).toBe(15000);
    expect(computeCouponDiscountMinor('FIXED', 999999, 100000)).toBe(100000); // capped
  });
});
