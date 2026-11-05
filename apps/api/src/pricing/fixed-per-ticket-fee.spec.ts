import { FeeMode } from '@eticketsgo/shared-types';
import { calculateFees, feeForTier, feeTierFromRule, type FeeTier } from './fee-calculator';
import {
  calculateFeesWithPolicy,
  policyFeeTiers,
  selectFeePolicy,
  type AppliedFeePolicy,
  type FeePolicyRow,
} from './fee-policy';
import { PricingService, paidTicketCount } from './pricing.service';
import { normaliseTerms } from '../admin/platform-fee-policies.service';
import { AdminService } from '../admin/admin.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import { ManualTaxProvider } from '../tax/providers/manual-tax.provider';

/**
 * Owner decisions 2026-10-29, the pure part:
 *
 *  - FIXED_PER_TICKET: fee = fixed amount x paid tickets. Independent of PERCENT and COMBINED,
 *    and NOT the legacy FLAT/FIXED, which charges once per order and must not change.
 *  - An optional minimum and maximum platform fee for COMBINED and FIXED_PER_TICKET, both unset
 *    by default, applied to the whole-order fee after it is computed. The snapshot says whether
 *    one applied.
 *  - Policies: precedence event -> organization -> schedule, and the clamp ("an override never
 *    charges more than the schedule") on the whole-order fee.
 */

const RS = (rupees: number) => rupees * 100;
const USD = (dollars: number) => dollars * 100;

const PER_TICKET_5: FeeTier = {
  minMinor: 0,
  maxMinor: null,
  feeMinor: RS(5),
  type: 'FIXED_PER_TICKET',
};

const fees = (tier: FeeTier, subtotalMinor: number, ticketCount: number, extra: object = {}) =>
  calculateFees({
    subtotalMinor,
    ticketCount,
    feeMode: FeeMode.CUSTOMER_PAYS,
    tiers: [tier],
    paymentFeeBps: 0,
    ...extra,
  });

describe('FIXED_PER_TICKET arithmetic', () => {
  it('one ticket: Rs 5', () => {
    const f = fees(PER_TICKET_5, RS(1_000), 1);
    expect(f.bookingFeeMinor).toBe(RS(5));
    expect(f.platformFeeBreakdown).toEqual({
      type: 'FIXED_PER_TICKET',
      percentBps: 0,
      fixedPerTicketMinor: RS(5),
      ticketCount: 1,
      percentPartMinor: 0,
      fixedPartMinor: RS(5),
    });
  });

  it('three tickets: Rs 15, whatever the ticket price', () => {
    expect(fees(PER_TICKET_5, RS(3_000), 3).bookingFeeMinor).toBe(RS(15));
    expect(fees(PER_TICKET_5, RS(300), 3).bookingFeeMinor).toBe(RS(15));
  });

  it('a mixed cart with a free ticket is charged for the paid tickets only', () => {
    const lines = [
      { unitPriceMinor: RS(1_000), quantity: 1 },
      { unitPriceMinor: RS(500), quantity: 1 },
      { unitPriceMinor: 0, quantity: 1 },
    ];
    const f = fees(PER_TICKET_5, RS(1_500), paidTicketCount(lines));
    expect(f.bookingFeeMinor).toBe(RS(10));
    expect(f.platformFeeBreakdown).toMatchObject({ ticketCount: 2, fixedPartMinor: RS(10) });
  });

  it('works in USD minor units (cents) exactly as in INR', () => {
    const tier: FeeTier = { ...PER_TICKET_5, feeMinor: 150 }; // $1.50 per ticket
    const f = fees(tier, USD(80), 4, { currency: 'USD' });
    expect(f.currency).toBe('USD');
    expect(f.bookingFeeMinor).toBe(600);
  });

  it('a free order pays nothing, even with a minimum fee', () => {
    const f = fees({ ...PER_TICKET_5, minFeeMinor: RS(20) }, 0, 2);
    expect(f.bookingFeeMinor).toBe(0);
    expect(f.totalMinor).toBe(0);
    expect(f.platformFeeBreakdown).toBeUndefined();
  });

  it('a 100% coupon pays nothing', () => {
    const f = fees(PER_TICKET_5, RS(1_000), 2, { discountMinor: RS(1_000) });
    expect(f.bookingFeeMinor).toBe(0);
  });

  it('the payment fee is still its own line, on net + the per-ticket fee', () => {
    const f = fees(PER_TICKET_5, RS(1_000), 3, { paymentFeeBps: 200 });
    expect(f.bookingFeeMinor).toBe(RS(15));
    expect(f.paymentFeeMinor).toBe(Math.round((200 * (RS(1_000) + RS(15))) / 10_000));
  });

  it('feeForTier agrees with calculateFees', () => {
    expect(feeForTier(PER_TICKET_5, RS(1_000), 3)).toBe(RS(15));
  });

  it('a stored FIXED_PER_TICKET row becomes a FIXED_PER_TICKET band', () => {
    const tier = feeTierFromRule({
      minMinor: 0,
      maxMinor: null,
      feeMinor: 500,
      feeType: 'FIXED_PER_TICKET',
      minFeeMinor: 1_000,
      maxFeeMinor: null,
    });
    expect(tier).toMatchObject({ type: 'FIXED_PER_TICKET', feeMinor: 500, minFeeMinor: 1_000 });
  });
});

describe('legacy FLAT / FIXED is unchanged (regression)', () => {
  const FLAT_10: FeeTier = { minMinor: 0, maxMinor: null, feeMinor: RS(10) };

  it.each([1, 3, 10])('a FLAT band charges once per order with %p ticket(s)', (n) => {
    const f = fees(FLAT_10, RS(1_000), n);
    expect(f.bookingFeeMinor).toBe(RS(10));
    expect(f.platformFeeBreakdown).toBeUndefined();
  });

  it('a FLAT row with stored limits still ignores them, as before', () => {
    const tier = feeTierFromRule({
      minMinor: 0,
      maxMinor: null,
      feeMinor: RS(10),
      feeType: 'FLAT',
      minFeeMinor: RS(50),
      maxFeeMinor: RS(1),
    });
    expect(fees(tier, RS(1_000), 3).bookingFeeMinor).toBe(RS(10));
  });

  it('a FIXED policy charges its amount once per order, not per ticket', () => {
    expect(policyFeeTiers({ kind: 'FIXED', feeMinor: RS(10) })).toEqual([
      { minMinor: 0, maxMinor: null, feeMinor: RS(10), type: 'FLAT' },
    ]);
    const out = calculateFeesWithPolicy({
      subtotalMinor: RS(1_000),
      ticketCount: 3,
      feeMode: FeeMode.CUSTOMER_PAYS,
      paymentFeeBps: 0,
      baseTiers: [{ minMinor: 0, maxMinor: null, feeMinor: RS(20) }],
      policy: { kind: 'FIXED', feeMinor: RS(10), applied: applied('FIXED') },
    });
    expect(out.fees.bookingFeeMinor).toBe(RS(10));
  });

  it('a PERCENT band keeps its minimum and maximum, and still has no breakdown', () => {
    const tier: FeeTier = {
      minMinor: 0,
      maxMinor: null,
      feeMinor: 0,
      type: 'PERCENT',
      percentBps: 500,
      minFeeMinor: RS(20),
      maxFeeMinor: RS(40),
    };
    expect(fees(tier, RS(100), 1).bookingFeeMinor).toBe(RS(20));
    expect(fees(tier, RS(600), 1).bookingFeeMinor).toBe(RS(30));
    expect(fees(tier, RS(10_000), 1).bookingFeeMinor).toBe(RS(40));
    expect(fees(tier, RS(10_000), 1).platformFeeBreakdown).toBeUndefined();
  });
});

describe('optional minimum and maximum (COMBINED and FIXED_PER_TICKET)', () => {
  const COMBINED_3_5: FeeTier = {
    minMinor: 0,
    maxMinor: null,
    feeMinor: RS(5),
    type: 'COMBINED',
    percentBps: 300,
  };

  it('unset by default: the fee is the sum of the parts and no limit is recorded', () => {
    const f = fees(COMBINED_3_5, RS(1_000), 1);
    expect(f.bookingFeeMinor).toBe(3_500);
    expect(f.platformFeeBreakdown).not.toHaveProperty('limitApplied');
    expect(f.platformFeeBreakdown).not.toHaveProperty('minFeeMinor');
  });

  it('COMBINED with a minimum: a small order is lifted to the minimum', () => {
    // 3% of Rs 100 + Rs 5 = Rs 8, held at a Rs 20 minimum.
    const f = fees({ ...COMBINED_3_5, minFeeMinor: RS(20) }, RS(100), 1);
    expect(f.bookingFeeMinor).toBe(RS(20));
    expect(f.platformFeeBreakdown).toMatchObject({
      percentPartMinor: 300,
      fixedPartMinor: 500,
      minFeeMinor: RS(20),
      maxFeeMinor: null,
      limitApplied: 'MIN',
    });
  });

  it('COMBINED with a minimum that does not bite records that no limit applied', () => {
    const f = fees({ ...COMBINED_3_5, minFeeMinor: RS(20) }, RS(1_000), 1);
    expect(f.bookingFeeMinor).toBe(3_500);
    expect(f.platformFeeBreakdown).toMatchObject({ limitApplied: null });
  });

  it('COMBINED with a maximum: a large order is held at the maximum', () => {
    // 3% of Rs 10,000 + 5 x Rs 5 = Rs 325, held at Rs 200.
    const f = fees({ ...COMBINED_3_5, maxFeeMinor: RS(200) }, RS(10_000), 5);
    expect(f.bookingFeeMinor).toBe(RS(200));
    expect(f.platformFeeBreakdown).toMatchObject({ limitApplied: 'MAX', maxFeeMinor: RS(200) });
  });

  it('FIXED_PER_TICKET with a minimum', () => {
    const f = fees({ ...PER_TICKET_5, minFeeMinor: RS(12) }, RS(400), 2);
    expect(f.bookingFeeMinor).toBe(RS(12));
    expect(f.platformFeeBreakdown).toMatchObject({ fixedPartMinor: RS(10), limitApplied: 'MIN' });
  });

  it('FIXED_PER_TICKET with a maximum', () => {
    const f = fees({ ...PER_TICKET_5, maxFeeMinor: RS(25) }, RS(8_000), 8);
    expect(f.bookingFeeMinor).toBe(RS(25));
    expect(f.platformFeeBreakdown).toMatchObject({ fixedPartMinor: RS(40), limitApplied: 'MAX' });
  });

  it('the payment fee is computed on the limited fee, not the parts', () => {
    const f = fees({ ...PER_TICKET_5, maxFeeMinor: RS(25) }, RS(8_000), 8, {
      paymentFeeBps: 200,
    });
    expect(f.paymentFeeMinor).toBe(Math.round((200 * (RS(8_000) + RS(25))) / 10_000));
  });
});

function applied(kind: AppliedFeePolicy['kind']): AppliedFeePolicy {
  return { id: `p-${kind}`, kind, scope: 'EVENT', version: 1, maxOrders: null };
}

describe('FIXED_PER_TICKET policies', () => {
  const schedule20: FeeTier[] = [{ minMinor: 0, maxMinor: null, feeMinor: RS(20) }];
  const withPolicy = (
    terms: { kind: string; feeMinor?: number; minFeeMinor?: number; maxFeeMinor?: number },
    ticketCount: number,
  ) =>
    calculateFeesWithPolicy({
      subtotalMinor: RS(1_000),
      ticketCount,
      feeMode: FeeMode.CUSTOMER_PAYS,
      paymentFeeBps: 0,
      baseTiers: schedule20,
      policy: { ...terms, applied: applied('FIXED_PER_TICKET') },
    });

  it('a policy of Rs 5 per ticket on three tickets: Rs 15 instead of the Rs 20 schedule', () => {
    const out = withPolicy({ kind: 'FIXED_PER_TICKET', feeMinor: RS(5) }, 3);
    expect(out.fees.bookingFeeMinor).toBe(RS(15));
    expect(out.policy?.kind).toBe('FIXED_PER_TICKET');
    expect(out.baseBookingFeeMinor).toBe(RS(20));
    expect(out.feeWaivedMinor).toBe(RS(5));
    expect(out.fees.platformFeeBreakdown).toMatchObject({ type: 'FIXED_PER_TICKET' });
  });

  it('clamp: five tickets at Rs 5 (Rs 25) would charge more than the schedule, so the schedule prices it', () => {
    const out = withPolicy({ kind: 'FIXED_PER_TICKET', feeMinor: RS(5) }, 5);
    expect(out.fees.bookingFeeMinor).toBe(RS(20));
    expect(out.policy).toBeNull();
    expect(out.fees.platformFeeBreakdown).toBeUndefined();
  });

  it('clamp: a policy minimum that lifts the fee above the schedule is not applied', () => {
    const out = withPolicy({ kind: 'FIXED_PER_TICKET', feeMinor: RS(1), minFeeMinor: RS(30) }, 1);
    expect(out.policy).toBeNull();
    expect(out.fees.bookingFeeMinor).toBe(RS(20));
  });

  it('a policy maximum is applied to the whole order', () => {
    const out = withPolicy({ kind: 'FIXED_PER_TICKET', feeMinor: RS(5), maxFeeMinor: RS(12) }, 3);
    expect(out.fees.bookingFeeMinor).toBe(RS(12));
    expect(out.fees.platformFeeBreakdown).toMatchObject({ limitApplied: 'MAX' });
  });

  it('a COMBINED policy can carry a minimum and maximum too', () => {
    expect(
      policyFeeTiers({ kind: 'COMBINED', percentBps: 300, feeMinor: 500, maxFeeMinor: 900 })[0],
    ).toMatchObject({ type: 'COMBINED', maxFeeMinor: 900, minFeeMinor: null });
  });

  it('precedence: an EVENT policy beats an ORGANIZATION policy, which beats the schedule', () => {
    const base = {
      organizationId: 'org',
      currency: 'INR',
      startsAt: new Date('2026-01-01'),
      endsAt: null,
      maxOrders: null,
      usedOrders: 0,
      status: 'ACTIVE',
      version: 1,
      percentBps: null,
      minFeeMinor: null,
      maxFeeMinor: null,
    };
    const org: FeePolicyRow = {
      ...base,
      id: 'org-p',
      scope: 'ORGANIZATION',
      eventId: null,
      kind: 'FIXED',
      feeMinor: RS(10),
    };
    const ev: FeePolicyRow = {
      ...base,
      id: 'ev-p',
      scope: 'EVENT',
      eventId: 'e1',
      kind: 'FIXED_PER_TICKET',
      feeMinor: RS(2),
    };
    const at = new Date('2026-10-29');
    expect(
      selectFeePolicy([org, ev], 'INR', { eventId: 'e1', organizationId: 'org', at })?.id,
    ).toBe('ev-p');
    expect(
      selectFeePolicy([org, ev], 'INR', { eventId: 'e2', organizationId: 'org', at })?.id,
    ).toBe('org-p');
    expect(
      selectFeePolicy([org, ev], 'INR', { eventId: 'e2', organizationId: 'x', at }),
    ).toBeNull();
  });

  describe('admin terms', () => {
    it('accepts an amount per ticket and a currency, no limits by default', () => {
      expect(normaliseTerms({ kind: 'FIXED_PER_TICKET', feeMinor: 500, currency: 'inr' })).toEqual({
        kind: 'FIXED_PER_TICKET',
        feeMinor: 500,
        percentBps: null,
        minFeeMinor: null,
        maxFeeMinor: null,
        currency: 'INR',
      });
    });

    it('accepts an optional minimum and maximum', () => {
      expect(
        normaliseTerms({
          kind: 'FIXED_PER_TICKET',
          feeMinor: 500,
          minFeeMinor: 1_000,
          maxFeeMinor: 5_000,
          currency: 'INR',
        }),
      ).toMatchObject({ minFeeMinor: 1_000, maxFeeMinor: 5_000 });
    });

    it.each([
      [{ kind: 'FIXED_PER_TICKET', currency: 'INR' }, /amount per ticket/],
      [{ kind: 'FIXED_PER_TICKET', feeMinor: 500 }, /currency/],
      [
        { kind: 'FIXED_PER_TICKET', feeMinor: 500, percentBps: 300, currency: 'INR' },
        /no percentage/,
      ],
      [
        {
          kind: 'FIXED_PER_TICKET',
          feeMinor: 500,
          minFeeMinor: 9,
          maxFeeMinor: 1,
          currency: 'INR',
        },
        /lowest fee cannot be more than the highest/,
      ],
      [{ kind: 'FIXED_PER_TICKET', feeMinor: 500, minFeeMinor: -1, currency: 'INR' }, /below zero/],
    ])('refuses %p', (input, message) => {
      expect(() => normaliseTerms(input as never)).toThrow(message);
    });
  });
});

describe('PricingService with a FIXED_PER_TICKET band', () => {
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
    feeType: 'FIXED_PER_TICKET',
    feePercentBps: null,
    minFeeMinor: null,
    maxFeeMinor: null,
    currency: 'INR',
    country: '*',
    region: '*',
  };

  it('counts paid tickets from the admission lines', async () => {
    const q = await make([ROW]).quote(RS(2_000), FeeMode.CUSTOMER_PAYS, 0, 'INR', {}, [
      { unitPriceMinor: RS(1_000), quantity: 2 },
      { unitPriceMinor: 0, quantity: 1 },
    ]);
    expect(q.bookingFeeMinor).toBe(RS(10));
    expect(q.platformFeeBreakdown).toMatchObject({ type: 'FIXED_PER_TICKET', ticketCount: 2 });
  });
});

describe('AdminService FIXED_PER_TICKET bands', () => {
  function make() {
    const create = jest.fn().mockImplementation(({ data }) => ({ id: 'n', ...data }));
    const prisma = {
      feeRule: { findMany: jest.fn().mockResolvedValue([]), create },
    } as unknown as PrismaService;
    const audit = { record: jest.fn() } as unknown as AuditService;
    return { svc: new AdminService(prisma, audit), create };
  }
  const BASE = { currency: 'INR', minMinor: 0, maxMinor: null, country: 'India' };

  it('stores the per-ticket amount, no percentage, and the optional limits', async () => {
    const { svc, create } = make();
    await svc.createFeeRule('a', {
      ...BASE,
      feeType: 'FIXED_PER_TICKET',
      feeMinor: 500,
      feePercentBps: 300,
      maxFeeMinor: 5_000,
    });
    expect(create.mock.calls[0][0].data).toMatchObject({
      feeType: 'FIXED_PER_TICKET',
      feeMinor: 500,
      feePercentBps: null,
      minFeeMinor: null,
      maxFeeMinor: 5_000,
    });
  });

  it('refuses a band with no amount per ticket', async () => {
    const { svc } = make();
    await expect(svc.createFeeRule('a', { ...BASE, feeType: 'FIXED_PER_TICKET' })).rejects.toThrow(
      /amount per ticket/,
    );
  });

  it('refuses a minimum above the maximum', async () => {
    const { svc } = make();
    await expect(
      svc.createFeeRule('a', {
        ...BASE,
        feeType: 'FIXED_PER_TICKET',
        feeMinor: 500,
        minFeeMinor: 900,
        maxFeeMinor: 100,
      }),
    ).rejects.toThrow(/minimum fee cannot be more than the maximum/);
  });
});
