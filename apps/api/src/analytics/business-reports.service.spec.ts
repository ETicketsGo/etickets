import 'reflect-metadata';
import { Role } from '@eticketsgo/shared-types';
import { BusinessReportsService, resolveRange, toCsv } from './business-reports.service';
import { AdminBusinessReportsController } from './business-reports.controller';
import { ROLES_KEY } from '../common/decorators';

const FROM = new Date('2026-07-01T00:00:00.000Z');
const TO = new Date('2026-07-31T23:59:59.999Z');

function makeService(
  overrides: {
    prisma?: Record<string, unknown>;
    analytics?: Record<string, unknown>;
    payouts?: Record<string, unknown>;
  } = {},
) {
  const prisma = {
    booking: { groupBy: jest.fn().mockResolvedValue([]) },
    refund: { groupBy: jest.fn().mockResolvedValue([]) },
    organization: { findMany: jest.fn().mockResolvedValue([]) },
    event: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    ...(overrides.prisma ?? {}),
  };
  const analytics = {
    // RevenueMetrics shape from AnalyticsService.revenue
    revenue: jest.fn().mockResolvedValue({
      grossMinor: 100000,
      bookingFeesMinor: 5000,
      paymentFeesMinor: 2000,
      organizerFeesMinor: 3000,
      discountMinor: 0,
      netMinor: 97000,
      confirmedBookings: 10,
    }),
    refundStats: jest.fn().mockResolvedValue({ count: 2, amountMinor: 8000 }),
    repeatCustomers: jest
      .fn()
      .mockResolvedValue({ totalCustomers: 3, repeatCustomers: 2, rate: 67 }),
    ...(overrides.analytics ?? {}),
  };
  const payouts = {
    adminList: jest.fn().mockResolvedValue([]),
    ...(overrides.payouts ?? {}),
  };
  return {
    prisma,
    analytics,
    payouts,
    service: new BusinessReportsService(prisma as never, analytics as never, payouts as never),
  };
}

describe('resolveRange', () => {
  it('defaults to a 30-day window ending now when no params given', () => {
    const { from, to } = resolveRange();
    const days = Math.round((to.getTime() - from.getTime()) / 86_400_000);
    expect(days).toBe(30);
  });
  it('widens date-only strings to cover the whole day', () => {
    const { from, to } = resolveRange('2026-07-01', '2026-07-01');
    expect(from.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-07-01T23:59:59.999Z');
  });
});

describe('BusinessReportsService.dailyRevenue', () => {
  it('merges grouped gross + refund days into one sorted series and reuses the aggregate totals', async () => {
    const { service, prisma, analytics } = makeService({
      prisma: {
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([
            {
              day: new Date('2026-07-01'),
              gross: 60000n,
              bookingfee: 3000n,
              paymentfee: 1000n,
              bookings: 6n,
            },
            {
              day: new Date('2026-07-02'),
              gross: 40000n,
              bookingfee: 2000n,
              paymentfee: 1000n,
              bookings: 4n,
            },
          ])
          .mockResolvedValueOnce([{ day: new Date('2026-07-02'), refunds: 8000n }]),
      },
    });

    const r = await service.dailyRevenue(FROM, TO);

    // Reuses the AnalyticsService aggregate helpers (no duplicated totals query).
    expect(analytics.revenue).toHaveBeenCalledTimes(1);
    expect(analytics.refundStats).toHaveBeenCalledTimes(1);

    expect(r.series).toHaveLength(2);
    expect(r.series[0]).toEqual({
      day: '2026-07-01',
      grossMinor: 60000,
      platformFeesMinor: 4000,
      refundsMinor: 0,
      netMinor: 60000,
      bookings: 6,
    });
    expect(r.series[1]).toEqual({
      day: '2026-07-02',
      grossMinor: 40000,
      platformFeesMinor: 3000,
      refundsMinor: 8000,
      netMinor: 32000,
      bookings: 4,
    });
    expect(r.totals).toEqual({
      grossMinor: 100000,
      platformFeesMinor: 7000,
      refundsMinor: 8000,
      netMinor: 92000,
      bookings: 10,
    });
    // The AnalyticsService.revenue where must carry the range in an AND clause so
    // it survives the helper's forced `confirmedAt: { not: null }`.
    expect(analytics.revenue).toHaveBeenCalledWith({
      AND: [{ confirmedAt: { gte: FROM, lte: TO } }],
    });
    void prisma;
  });
});

describe('BusinessReportsService.organizerRevenue', () => {
  it('composes per-org gross/net/refunds sorted by gross desc (net mirrors payout math)', async () => {
    const { service } = makeService({
      prisma: {
        booking: {
          groupBy: jest.fn().mockResolvedValue([
            {
              organizationId: 'o2',
              _sum: {
                subtotalMinor: 50000,
                organizerFeeMinor: 1000,
                bookingFeeMinor: 2000,
                paymentFeeMinor: 1000,
              },
              _count: { _all: 5 },
            },
            {
              organizationId: 'o1',
              _sum: {
                subtotalMinor: 100000,
                organizerFeeMinor: 3000,
                bookingFeeMinor: 5000,
                paymentFeeMinor: 2000,
              },
              _count: { _all: 10 },
            },
          ]),
        },
        refund: {
          groupBy: jest
            .fn()
            .mockResolvedValue([{ organizationId: 'o1', _sum: { amountMinor: 8000 } }]),
        },
        organization: {
          findMany: jest.fn().mockResolvedValue([
            { id: 'o1', name: 'Alpha' },
            { id: 'o2', name: 'Beta' },
          ]),
        },
      },
    });

    const r = await service.organizerRevenue(FROM, TO);
    expect(r.organizers.map((o) => o.organizationId)).toEqual(['o1', 'o2']);
    expect(r.organizers[0]).toEqual({
      organizationId: 'o1',
      organizationName: 'Alpha',
      grossMinor: 100000,
      platformFeesMinor: 7000,
      refundsMinor: 8000,
      netMinor: 89000, // 100000 - 3000 organizer fee - 8000 refunds
      bookings: 10,
    });
    expect(r.organizers[1].netMinor).toBe(49000); // 50000 - 1000 - 0
  });

  it('applies a top-N limit', async () => {
    const { service } = makeService({
      prisma: {
        booking: {
          groupBy: jest.fn().mockResolvedValue([
            { organizationId: 'o1', _sum: { subtotalMinor: 100 }, _count: { _all: 1 } },
            { organizationId: 'o2', _sum: { subtotalMinor: 50 }, _count: { _all: 1 } },
          ]),
        },
      },
    });
    const r = await service.organizerRevenue(FROM, TO, 1);
    expect(r.organizers).toHaveLength(1);
  });
});

describe('BusinessReportsService.settlement', () => {
  it('folds PayoutsService.adminList into outstanding vs paid per org (no payout math duplicated)', async () => {
    const { service, payouts } = makeService({
      payouts: {
        adminList: jest.fn().mockResolvedValue([
          {
            organizationId: 'o1',
            organization: { name: 'Alpha' },
            netMinor: 50000,
            status: 'PAID',
          },
          {
            organizationId: 'o1',
            organization: { name: 'Alpha' },
            netMinor: 20000,
            status: 'PENDING',
          },
          {
            organizationId: 'o2',
            organization: { name: 'Beta' },
            netMinor: 10000,
            status: 'SCHEDULED',
          },
        ]),
      },
    });

    const r = await service.settlement();
    expect(payouts.adminList).toHaveBeenCalledTimes(1);
    expect(r.totals).toEqual({ outstandingMinor: 30000, paidMinor: 50000, payoutCount: 3 });
    // Sorted by outstanding desc → o1 (20000) before o2 (10000).
    expect(r.byOrg[0]).toEqual({
      organizationId: 'o1',
      organizationName: 'Alpha',
      outstandingMinor: 20000,
      paidMinor: 50000,
      outstandingCount: 1,
      paidCount: 1,
    });
  });
});

describe('BusinessReportsService.refunds', () => {
  it('returns totals (reused), by-status groups and a by-day series', async () => {
    const { service, analytics } = makeService({
      prisma: {
        refund: {
          groupBy: jest.fn().mockResolvedValue([
            { status: 'COMPLETED', _sum: { amountMinor: 8000 }, _count: { _all: 2 } },
            { status: 'REQUESTED', _sum: { amountMinor: 5000 }, _count: { _all: 1 } },
          ]),
        },
        $queryRaw: jest
          .fn()
          .mockResolvedValue([{ day: new Date('2026-07-02'), count: 2n, amount: 8000n }]),
      },
    });
    const r = await service.refunds(FROM, TO);
    expect(analytics.refundStats).toHaveBeenCalledTimes(1);
    expect(r.totals).toEqual({ count: 2, amountMinor: 8000 });
    expect(r.byStatus).toHaveLength(2);
    expect(r.byDay).toEqual([{ day: '2026-07-02', count: 2, amountMinor: 8000 }]);
  });
});

describe('BusinessReportsService.platformFees', () => {
  it('reports fees over the range and a daily series', async () => {
    const { service } = makeService({
      prisma: {
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([
            {
              day: new Date('2026-07-01'),
              gross: 60000n,
              bookingfee: 3000n,
              paymentfee: 1000n,
              bookings: 6n,
            },
          ])
          .mockResolvedValueOnce([]),
      },
    });
    const r = await service.platformFees(FROM, TO);
    expect(r.totals.platformFeesMinor).toBe(7000); // from reused revenue aggregate
    expect(r.series).toEqual([{ day: '2026-07-01', feesMinor: 4000 }]);
  });
});

describe('BusinessReportsService.tax', () => {
  /*
    This report used to hardcode `taxModelled: false` and zero, and kept saying so for the
    whole period after tax became real — a true statement that quietly became a false one.
    It now reads what was actually CHARGED, and `taxModelled` answers a different question:
    whether any rule is configured at all, so an honest zero is distinguishable from a
    platform that never asked.
  */
  const taxPrisma = (
    lines: { label: string; rateBasisPoints: number; baseMinor: number; amountMinor: number }[],
    activeRules: number,
  ) => ({
    bookingTaxLine: { findMany: jest.fn().mockResolvedValue(lines) },
    taxRule: { count: jest.fn().mockResolvedValue(activeRules) },
  });

  it('reports no tax, and says why, when no rule is configured', async () => {
    const { service } = makeService({ prisma: taxPrisma([], 0) });
    const r = await service.tax(FROM, TO);
    expect(r.taxModelled).toBe(false);
    expect(r.taxCollectedMinor).toBe(0);
    expect(r.breakdown).toEqual([]);
    expect(r.note).toMatch(/no tax rule is active/i);
    // The taxable base is still reported, which is what it was always for.
    expect(r.taxableBaseMinor).toBe(107000);
  });

  it('reports what was charged, grouped by label AND rate', async () => {
    /*
      Cinema at 5% and a concert at 18% are both "CGST". Summing them into one line would
      hide exactly the split a filing has to state, so the rate is part of the key.
    */
    const { service } = makeService({
      prisma: taxPrisma(
        [
          { label: 'CGST', rateBasisPoints: 250, baseMinor: 1000, amountMinor: 25 },
          { label: 'CGST', rateBasisPoints: 250, baseMinor: 2000, amountMinor: 50 },
          { label: 'CGST', rateBasisPoints: 900, baseMinor: 10000, amountMinor: 900 },
          { label: 'SGST', rateBasisPoints: 900, baseMinor: 10000, amountMinor: 900 },
        ],
        6,
      ),
    });
    const r = await service.tax(FROM, TO);

    expect(r.taxModelled).toBe(true);
    expect(r.taxCollectedMinor).toBe(1875);
    expect(r.breakdown).toEqual([
      { label: 'CGST', rateBasisPoints: 250, baseMinor: 3000, amountMinor: 75 },
      { label: 'CGST', rateBasisPoints: 900, baseMinor: 10000, amountMinor: 900 },
      { label: 'SGST', rateBasisPoints: 900, baseMinor: 10000, amountMinor: 900 },
    ]);
    expect(r.note).toMatch(/as CHARGED|not a return/i);
  });

  it('does not claim to be a filing', async () => {
    // The line between "what we collected" and "what you owe" is the one worth keeping.
    const { service } = makeService({ prisma: taxPrisma([], 3) });
    const r = await service.tax(FROM, TO);
    expect(r.note).toMatch(/not a return|reference only/i);
  });
});

describe('BusinessReportsService.topExperiences', () => {
  it('ranks events by bookings and joins the title', async () => {
    const { service } = makeService({
      prisma: {
        booking: {
          groupBy: jest
            .fn()
            .mockResolvedValue([
              { eventId: 'e1', _sum: { subtotalMinor: 60000 }, _count: { _all: 6 } },
            ]),
        },
        event: {
          findMany: jest
            .fn()
            .mockResolvedValue([
              { id: 'e1', title: 'Concert', experienceType: 'EVENT', movie: null },
            ]),
        },
      },
    });
    const r = await service.topExperiences(FROM, TO, 5);
    expect(r.experiences[0]).toEqual({
      eventId: 'e1',
      title: 'Concert',
      experienceType: 'EVENT',
      movieTitle: null,
      bookings: 6,
      grossMinor: 60000,
    });
  });
});

describe('BusinessReportsService.growth', () => {
  it('returns new-user + new-booking series and reuses the retention helper', async () => {
    const { service, analytics } = makeService({
      prisma: {
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([{ day: new Date('2026-07-01'), count: 5n }])
          .mockResolvedValueOnce([{ day: new Date('2026-07-01'), count: 10n }])
          .mockResolvedValueOnce([{ day: new Date('2026-07-01'), count: 2n }]),
      },
    });
    const r = await service.growth(FROM, TO);
    expect(analytics.repeatCustomers).toHaveBeenCalledWith({});
    expect(r.retention.rate).toBe(67);
    expect(r.newUsers).toEqual([{ day: '2026-07-01', count: 5 }]);
    expect(r.newBookings).toEqual([{ day: '2026-07-01', count: 10 }]);
    expect(r.newOrganizers).toEqual([{ day: '2026-07-01', count: 2 }]);
  });
});

describe('BusinessReportsService.paymentHealth', () => {
  it('computes success rate overall and per provider, sorted by volume', async () => {
    const { service } = makeService({
      prisma: {
        payment: {
          groupBy: jest.fn().mockResolvedValue([
            { provider: 'stripe', status: 'SUCCEEDED', _count: { _all: 9 } },
            { provider: 'stripe', status: 'FAILED', _count: { _all: 1 } },
            { provider: 'razorpay', status: 'SUCCEEDED', _count: { _all: 3 } },
            { provider: 'razorpay', status: 'FAILED', _count: { _all: 1 } },
            { provider: 'razorpay', status: 'PROCESSING', _count: { _all: 2 } },
          ]),
        },
      },
    });
    const r = await service.paymentHealth(FROM, TO);
    // 12 succeeded / 14 settled → 85.7% overall.
    expect(r.overallSuccessRate).toBe(85.7);
    // Sorted by settled volume desc: stripe (10) before razorpay (4).
    expect(r.providers.map((p) => p.provider)).toEqual(['stripe', 'razorpay']);
    expect(r.providers[0]).toMatchObject({ succeeded: 9, failed: 1, successRate: 90 });
    expect(r.providers[1]).toMatchObject({ succeeded: 3, failed: 1, pending: 2, successRate: 75 });
  });

  it('returns null rates when nothing has settled', async () => {
    const { service } = makeService({
      prisma: {
        payment: {
          groupBy: jest
            .fn()
            .mockResolvedValue([{ provider: 'stripe', status: 'PROCESSING', _count: { _all: 4 } }]),
        },
      },
    });
    const r = await service.paymentHealth(FROM, TO);
    expect(r.overallSuccessRate).toBeNull();
    expect(r.providers[0].successRate).toBeNull();
    expect(r.providers[0].pending).toBe(4);
  });
});

describe('toCsv (injection-safe)', () => {
  it('quotes fields, escapes embedded quotes, and neutralises formula injection', () => {
    const csv = toCsv(
      ['name', 'value'],
      [
        ['=SUM(A1)', 'he"llo, world'],
        ['+cmd', 'ok'],
      ],
    );
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('"name","value"');
    // Formula-leading cells get a `'` prefix; quotes are doubled.
    expect(lines[1]).toBe('"\'=SUM(A1)","he""llo, world"');
    expect(lines[2]).toBe('"\'+cmd","ok"');
  });

  it('dailyRevenueCsv emits a header + one row per day', async () => {
    const { service } = makeService({
      prisma: {
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([
            {
              day: new Date('2026-07-01'),
              gross: 60000n,
              bookingfee: 3000n,
              paymentfee: 1000n,
              bookings: 6n,
            },
          ])
          .mockResolvedValueOnce([]),
      },
    });
    const csv = await service.dailyRevenueCsv(FROM, TO);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(
      '"day","grossMinor","platformFeesMinor","refundsMinor","netMinor","bookings"',
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"2026-07-01"');
  });
});

describe('AdminBusinessReportsController role-gating', () => {
  it('restricts the whole controller to ADMIN / SUPER_ADMIN', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, AdminBusinessReportsController);
    expect(roles).toEqual([Role.ADMIN, Role.SUPER_ADMIN]);
  });
});
