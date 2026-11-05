import { FeeMode } from '@eticketsgo/shared-types';
import {
  calculateFees,
  combinedFeeParts,
  feeForTier,
  feeTierFromRule,
  type FeeTier,
} from './fee-calculator';
import { calculateFeesWithPolicy, policyFeeTiers, type AppliedFeePolicy } from './fee-policy';
import { PricingService, paidTicketCount } from './pricing.service';
import { normaliseTerms } from '../admin/platform-fee-policies.service';
import type { PrismaService } from '../prisma/prisma.service';
import { ManualTaxProvider } from '../tax/providers/manual-tax.provider';

/**
 * COMBINED platform fee: a percentage of the order plus a fixed amount per paid ticket.
 *
 * The owner's example is the anchor: one Rs 1,000 ticket at 3% + Rs 5 = Rs 35 (3500 paise).
 * Everything else here pins how it composes with what already existed - band selection by
 * order total, the payment fee on top, fee modes, policies and their "never more than the
 * schedule" clamp, free orders, and rounding.
 */

const PAISE = 100;
const RS = (rupees: number) => rupees * PAISE;

/** 3% + Rs 5 per ticket, for every order. */
const COMBINED_3_5: FeeTier = {
  minMinor: 0,
  maxMinor: null,
  feeMinor: RS(5),
  type: 'COMBINED',
  percentBps: 300,
};

const fees = (subtotalMinor: number, ticketCount: number, extra: object = {}) =>
  calculateFees({
    subtotalMinor,
    ticketCount,
    feeMode: FeeMode.CUSTOMER_PAYS,
    tiers: [COMBINED_3_5],
    paymentFeeBps: 0,
    ...extra,
  });

describe('COMBINED fee arithmetic', () => {
  it("the owner's example: one Rs 1,000 ticket at 3% + Rs 5 is Rs 35 (3500 paise)", () => {
    const f = fees(RS(1_000), 1);
    expect(f.bookingFeeMinor).toBe(3_500);
    expect(f.platformFeeBreakdown).toEqual({
      type: 'COMBINED',
      percentBps: 300,
      fixedPerTicketMinor: 500,
      ticketCount: 1,
      percentPartMinor: 3_000,
      fixedPartMinor: 500,
    });
  });

  it('three Rs 1,000 tickets: Rs 90 + 3 x Rs 5 = Rs 105', () => {
    const f = fees(RS(3_000), 3);
    expect(f.bookingFeeMinor).toBe(10_500);
    expect(f.platformFeeBreakdown).toMatchObject({
      percentPartMinor: 9_000,
      fixedPartMinor: 1_500,
    });
  });

  it('the percentage is the same on the order as on each ticket summed (before rounding)', () => {
    // Rs 1,000 + Rs 500 + Rs 250: 3% each = 30 + 15 + 7.50 = Rs 52.50, plus 3 x Rs 5.
    expect(fees(RS(1_750), 3).bookingFeeMinor).toBe(5_250 + 1_500);
  });

  it('INR rounds the percentage half up once, to the paisa', () => {
    // Rs 333.33 at 3% = Rs 9.9999 -> Rs 10.00
    expect(fees(33_333, 1).platformFeeBreakdown!.percentPartMinor).toBe(1_000);
    // 50 paise at 1% = 0.5 paise -> 1 paisa (half up)
    expect(combinedFeeParts({ feeMinor: 0, percentBps: 100 }, 50, 1).percentPartMinor).toBe(1);
    // 49 paise at 1% = 0.49 -> 0
    expect(combinedFeeParts({ feeMinor: 0, percentBps: 100 }, 49, 1).percentPartMinor).toBe(0);
  });

  it('USD rounds to the cent: 3 x $10.33 at 3% + $0.50 per ticket', () => {
    const usd = calculateFees({
      subtotalMinor: 3_099,
      ticketCount: 3,
      feeMode: FeeMode.CUSTOMER_PAYS,
      currency: 'USD',
      paymentFeeBps: 0,
      tiers: [{ minMinor: 0, maxMinor: null, feeMinor: 50, type: 'COMBINED', percentBps: 300 }],
    });
    // 3099 * 3% = 92.97 -> 93 cents; + 150 cents
    expect(usd.bookingFeeMinor).toBe(243);
    expect(usd.currency).toBe('USD');
  });

  it('the fixed part is per PAID ticket; a free ticket in a mixed cart is not charged it', () => {
    const lines = [
      { unitPriceMinor: RS(1_000), quantity: 1 },
      { unitPriceMinor: RS(500), quantity: 1 },
      { unitPriceMinor: 0, quantity: 2 },
    ];
    expect(paidTicketCount(lines)).toBe(2);
    expect(fees(RS(1_500), paidTicketCount(lines)).bookingFeeMinor).toBe(4_500 + 1_000);
    // No cart known: one ticket.
    expect(paidTicketCount(undefined)).toBe(1);
  });

  it('a mixed cart falls in ONE band, chosen by the order total (unchanged behaviour)', () => {
    const schedule: FeeTier[] = [
      { minMinor: 0, maxMinor: RS(999), feeMinor: RS(10) }, // FLAT Rs 10 below Rs 1,000
      { ...COMBINED_3_5, minMinor: RS(1_000) }, // 3% + Rs 5 per ticket from Rs 1,000
    ];
    // Rs 600 + Rs 600 = Rs 1,200: the order is in the COMBINED band, both tickets pay Rs 5.
    const f = calculateFees({
      subtotalMinor: RS(1_200),
      ticketCount: 2,
      feeMode: FeeMode.CUSTOMER_PAYS,
      tiers: schedule,
      paymentFeeBps: 0,
    });
    expect(f.bookingFeeMinor).toBe(3_600 + 1_000);
    // One Rs 600 ticket alone is in the FLAT band.
    const one = calculateFees({
      subtotalMinor: RS(600),
      ticketCount: 1,
      feeMode: FeeMode.CUSTOMER_PAYS,
      tiers: schedule,
      paymentFeeBps: 0,
    });
    expect(one.bookingFeeMinor).toBe(RS(10));
    expect(one.platformFeeBreakdown).toBeUndefined();
  });

  it('a free order pays nothing, whatever the band says', () => {
    const free = fees(0, 4);
    expect(free.bookingFeeMinor).toBe(0);
    expect(free.totalMinor).toBe(0);
    expect(free.platformFeeBreakdown).toBeUndefined();
    // A 100% coupon is the same.
    expect(fees(RS(1_000), 1, { discountMinor: RS(1_000) }).bookingFeeMinor).toBe(0);
  });

  it('the percentage is on the order after discount; the fixed part is not discounted', () => {
    // Rs 1,000 with Rs 200 off: 3% of Rs 800 = Rs 24, + Rs 5.
    expect(fees(RS(1_000), 1, { discountMinor: RS(200) }).bookingFeeMinor).toBe(2_400 + 500);
  });

  it('the payment fee is still bps x (net + booking fee), its own line', () => {
    const f = fees(RS(1_000), 1, { paymentFeeBps: 200 });
    expect(f.bookingFeeMinor).toBe(3_500);
    expect(f.paymentFeeMinor).toBe(Math.round((200 * (RS(1_000) + 3_500)) / 10_000));
    expect(f.customerFeeMinor).toBe(f.bookingFeeMinor + f.paymentFeeMinor);
    expect(f.totalMinor).toBe(RS(1_000) + f.customerFeeMinor);
  });

  it('ORGANIZER_PAYS: the buyer pays the ticket only and the organizer absorbs the whole fee', () => {
    const f = fees(RS(1_000), 1, { feeMode: FeeMode.ORGANIZER_PAYS, paymentFeeBps: 200 });
    expect(f.bookingFeeMinor).toBe(3_500);
    expect(f.customerFeeMinor).toBe(0);
    expect(f.organizerFeeMinor).toBe(3_500 + f.paymentFeeMinor);
    expect(f.totalMinor).toBe(RS(1_000));
  });

  it('SHARED splits the combined fee like any other', () => {
    const f = fees(RS(1_000), 1, { feeMode: FeeMode.SHARED });
    expect(f.customerFeeMinor + f.organizerFeeMinor).toBe(3_500);
    expect(f.customerFeeMinor).toBe(1_750);
  });

  it('every other band type ignores the ticket count', () => {
    const flat: FeeTier = { minMinor: 0, maxMinor: null, feeMinor: RS(20) };
    const pct: FeeTier = {
      minMinor: 0,
      maxMinor: null,
      feeMinor: 0,
      type: 'PERCENT',
      percentBps: 500,
    };
    expect(feeForTier(flat, RS(1_000), 7)).toBe(RS(20));
    expect(feeForTier(pct, RS(1_000), 7)).toBe(RS(50));
    const r = calculateFees({
      subtotalMinor: RS(1_000),
      ticketCount: 7,
      feeMode: FeeMode.CUSTOMER_PAYS,
      tiers: [flat],
    });
    expect(r).toEqual(
      calculateFees({ subtotalMinor: RS(1_000), feeMode: FeeMode.CUSTOMER_PAYS, tiers: [flat] }),
    );
    expect(r.platformFeeBreakdown).toBeUndefined();
  });

  it('a stored COMBINED row becomes a COMBINED band', () => {
    expect(
      feeTierFromRule({
        minMinor: 0,
        maxMinor: null,
        feeMinor: 500,
        feeType: 'COMBINED',
        feePercentBps: 300,
      }),
    ).toMatchObject({ type: 'COMBINED', feeMinor: 500, percentBps: 300 });
  });
});

describe('COMBINED platform fee policies', () => {
  const applied = (kind: AppliedFeePolicy['kind']): AppliedFeePolicy => ({
    id: 'p1',
    kind,
    scope: 'EVENT',
    version: 1,
    maxOrders: null,
  });
  const flatSchedule: FeeTier[] = [{ minMinor: 0, maxMinor: null, feeMinor: RS(50) }];

  it('a COMBINED policy is one open band of its terms', () => {
    expect(policyFeeTiers({ kind: 'COMBINED', percentBps: 300, feeMinor: 500 })).toEqual([
      {
        minMinor: 0,
        maxMinor: null,
        feeMinor: 500,
        type: 'COMBINED',
        percentBps: 300,
        minFeeMinor: null,
        maxFeeMinor: null,
      },
    ]);
  });

  it('applies when it charges less than the schedule, and records what it took off', () => {
    const out = calculateFeesWithPolicy({
      subtotalMinor: RS(1_000),
      ticketCount: 1,
      feeMode: FeeMode.CUSTOMER_PAYS,
      baseTiers: flatSchedule,
      policy: { kind: 'COMBINED', percentBps: 300, feeMinor: 500, applied: applied('COMBINED') },
    });
    expect(out.fees.bookingFeeMinor).toBe(3_500);
    expect(out.policy?.kind).toBe('COMBINED');
    expect(out.baseBookingFeeMinor).toBe(RS(50));
    expect(out.feeWaivedMinor).toBe(RS(50) - 3_500);
    expect(out.fees.platformFeeBreakdown).toMatchObject({ ticketCount: 1, fixedPartMinor: 500 });
  });

  it('never charges more than the schedule: compared on the whole order, ticket count included', () => {
    // 3 tickets: 3% of Rs 3,000 + 3 x Rs 5 = Rs 105, above the Rs 50 schedule fee.
    const out = calculateFeesWithPolicy({
      subtotalMinor: RS(3_000),
      ticketCount: 3,
      feeMode: FeeMode.CUSTOMER_PAYS,
      baseTiers: flatSchedule,
      policy: { kind: 'COMBINED', percentBps: 300, feeMinor: 500, applied: applied('COMBINED') },
    });
    expect(out.policy).toBeNull();
    expect(out.fees.bookingFeeMinor).toBe(RS(50));
    expect(out.fees.platformFeeBreakdown).toBeUndefined();
  });

  it('a FIXED override beats a COMBINED schedule band when it is cheaper', () => {
    const out = calculateFeesWithPolicy({
      subtotalMinor: RS(1_000),
      ticketCount: 1,
      feeMode: FeeMode.CUSTOMER_PAYS,
      baseTiers: [COMBINED_3_5],
      policy: { kind: 'FIXED', feeMinor: RS(10), applied: applied('FIXED') },
    });
    expect(out.fees.bookingFeeMinor).toBe(RS(10));
    expect(out.baseBookingFeeMinor).toBe(3_500);
    expect(out.fees.platformFeeBreakdown).toBeUndefined();
  });

  it('a WAIVE override zeroes a COMBINED schedule band', () => {
    const out = calculateFeesWithPolicy({
      subtotalMinor: RS(1_000),
      ticketCount: 2,
      feeMode: FeeMode.CUSTOMER_PAYS,
      baseTiers: [COMBINED_3_5],
      policy: { kind: 'WAIVE', applied: applied('WAIVE') },
    });
    expect(out.fees.bookingFeeMinor).toBe(0);
    expect(out.feeWaivedMinor).toBe(3_000 + 1_000);
  });

  it('a free order is never recorded against a COMBINED policy', () => {
    const out = calculateFeesWithPolicy({
      subtotalMinor: 0,
      ticketCount: 2,
      feeMode: FeeMode.CUSTOMER_PAYS,
      baseTiers: flatSchedule,
      policy: { kind: 'COMBINED', percentBps: 300, feeMinor: 500, applied: applied('COMBINED') },
    });
    expect(out.policy).toBeNull();
    expect(out.fees.bookingFeeMinor).toBe(0);
  });

  describe('admin terms', () => {
    it('accepts a percentage, a per-ticket amount and a currency', () => {
      expect(
        normaliseTerms({ kind: 'COMBINED', percentBps: 300, feeMinor: 500, currency: 'inr' }),
      ).toEqual({
        kind: 'COMBINED',
        percentBps: 300,
        feeMinor: 500,
        minFeeMinor: null,
        maxFeeMinor: null,
        currency: 'INR',
      });
    });

    it.each([
      [{ kind: 'COMBINED', feeMinor: 500, currency: 'INR' }, /percentage/],
      [{ kind: 'COMBINED', percentBps: 300, currency: 'INR' }, /fixed amount per ticket/],
      [{ kind: 'COMBINED', percentBps: 300, feeMinor: 0, currency: 'INR' }, /fixed amount/],
      [{ kind: 'COMBINED', percentBps: 300, feeMinor: 500 }, /currency/],
      // Owner decision 2026-10-29: limits are optional, but the lowest may not pass the highest.
      [
        {
          kind: 'COMBINED',
          percentBps: 300,
          feeMinor: 500,
          minFeeMinor: 900,
          maxFeeMinor: 9,
          currency: 'INR',
        },
        /lowest fee cannot be more than the highest/,
      ],
    ])('refuses %p', (input, message) => {
      expect(() => normaliseTerms(input as never)).toThrow(message);
    });
  });
});

describe('PricingService with a COMBINED band', () => {
  function make(rows: unknown[]) {
    const prisma = {
      feeRule: { findMany: jest.fn().mockResolvedValue(rows) },
      taxRule: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    return new PricingService(prisma, new ManualTaxProvider(prisma), {
      get: () => undefined,
    } as never);
  }
  const ROW = {
    minMinor: 0,
    maxMinor: null,
    feeMinor: 500,
    feeType: 'COMBINED',
    feePercentBps: 300,
    currency: 'INR',
    country: '*',
    region: '*',
  };

  it('counts paid tickets from the admission lines', async () => {
    const q = await make([ROW]).quote(RS(2_000), FeeMode.CUSTOMER_PAYS, 0, 'INR', {}, [
      { unitPriceMinor: RS(1_000), quantity: 2 },
      { unitPriceMinor: 0, quantity: 1 },
    ]);
    expect(q.bookingFeeMinor).toBe(6_000 + 1_000);
    expect(q.platformFeeBreakdown).toMatchObject({ ticketCount: 2 });
  });

  it('drops the breakdown when a jurisdiction cap lowers the fee', async () => {
    const q = await make([ROW]).quote(
      RS(1_000),
      FeeMode.CUSTOMER_PAYS,
      0,
      'INR',
      {},
      [{ unitPriceMinor: RS(1_000), quantity: 1 }],
      {
        maintenanceMinor: 0,
        maintenanceTreatment: 'NOT_APPLICABLE',
        maintenanceAddedMinor: 0,
        maintenanceTaxCategory: null,
        maxOnlineFeeMinor: 1_000,
        complianceStatus: 'COMPLIANT',
        explanation: 'test cap',
      } as never,
    );
    expect(q.customerFeeMinor).toBe(1_000);
    expect(q.platformFeeBreakdown).toBeUndefined();
  });
});
