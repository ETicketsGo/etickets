import { ReportsService } from './reports.service';

/**
 * The platform overview's money, one currency at a time.
 *
 * Reported from QA: "Gross merchandise value ₹11,389.60" was rupees, US dollars and Canadian
 * dollars added together and printed with a rupee sign. These tests pin that every figure is
 * grouped by the currency the booking was sold in, refunds included — which carry no currency
 * of their own and take their booking's.
 *
 * Reported again: the overview then showed India alone. A market was listed only once it had
 * taken money, and every US checkout had expired. These tests also pin that every market the
 * platform operates in is listed — by booking, refund or venue — with its zeros.
 */
describe('ReportsService.adminDashboard — money per currency', () => {
  function setup(
    paid: object[],
    refunds: object[],
    more: { all?: object[]; failures?: object[]; venues?: object[] } = {},
  ) {
    const prisma = {
      booking: {
        // Two groupings share this call: paid bookings filter on `confirmedAt`, all bookings do not.
        groupBy: jest.fn((args: { where?: unknown }) =>
          Promise.resolve(args.where ? paid : (more.all ?? [])),
        ),
        count: jest.fn().mockResolvedValue(40),
      },
      // Two raw queries too, told apart by the table they read rather than by call order.
      $queryRaw: jest.fn((sql: TemplateStringsArray) =>
        Promise.resolve(sql.join('').includes('"Refund"') ? refunds : (more.failures ?? [])),
      ),
      venue: { findMany: jest.fn().mockResolvedValue(more.venues ?? []) },
      organization: { count: jest.fn().mockResolvedValue(3) },
      event: { count: jest.fn().mockResolvedValue(9) },
      payment: { count: jest.fn().mockResolvedValue(2) },
      payout: { count: jest.fn().mockResolvedValue(1) },
    };
    const service = new ReportsService(prisma as never, {} as never);
    return { service, prisma };
  }

  const row = (
    currency: string,
    total: number,
    bookingFee: number,
    paymentFee: number,
    count: number,
  ) => ({
    currency,
    _sum: { totalMinor: total, bookingFeeMinor: bookingFee, paymentFeeMinor: paymentFee },
    _count: { _all: count },
  });
  const all = (currency: string, count: number) => ({ currency, _count: { _all: count } });
  const zero = (currency: string, country: string | null) => ({
    currency,
    country,
    gmvMinor: 0,
    platformRevenueMinor: 0,
    refundVolumeMinor: 0,
    paidBookings: 0,
    totalBookings: 0,
    paymentFailures: 0,
  });

  it('never adds rupees to dollars', async () => {
    const { service } = setup(
      [row('INR', 1_000_000, 20_000, 10_000, 30), row('USD', 12_000, 300, 200, 2)],
      [
        { currency: 'INR', amountMinor: BigInt(179_900) },
        { currency: 'USD', amountMinor: 4_000 },
      ],
      {
        all: [all('INR', 41), all('USD', 5)],
        failures: [
          { currency: 'INR', count: BigInt(3) },
          { currency: 'USD', count: 1 },
        ],
      },
    );
    const d = await service.adminDashboard();
    expect(d.money).toEqual([
      {
        currency: 'INR',
        country: 'IN',
        gmvMinor: 1_000_000,
        platformRevenueMinor: 30_000,
        refundVolumeMinor: 179_900,
        paidBookings: 30,
        totalBookings: 41,
        paymentFailures: 3,
      },
      {
        currency: 'USD',
        country: 'US',
        gmvMinor: 12_000,
        platformRevenueMinor: 500,
        refundVolumeMinor: 4_000,
        paidBookings: 2,
        totalBookings: 5,
        paymentFailures: 1,
      },
    ]);
  });

  it('puts the biggest market first, so the page opens on it', async () => {
    const { service } = setup([row('CAD', 5_000, 0, 0, 1), row('INR', 900_000, 0, 0, 9)], []);
    const d = await service.adminDashboard();
    expect(d.money.map((m) => m.currency)).toEqual(['INR', 'CAD']);
  });

  it('lists a currency that only has refunds, rather than dropping the money', async () => {
    const { service } = setup([], [{ currency: 'cad', amountMinor: 2_500 }]);
    const d = await service.adminDashboard();
    expect(d.money).toEqual([{ ...zero('CAD', 'CA'), refundVolumeMinor: 2_500 }]);
  });

  it('groups paid bookings by currency in the query itself', async () => {
    const { service, prisma } = setup([], []);
    await service.adminDashboard();
    expect(prisma.booking.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ by: ['currency'], where: { confirmedAt: { not: null } } }),
    );
  });

  it('lists a market whose bookings were never paid, with zero money and its bookings', async () => {
    // QA exactly: rupees sold, and twelve US checkouts that all expired or are still pending.
    const { service } = setup([row('INR', 1_138_960, 0, 0, 11)], [], {
      all: [all('INR', 23), all('usd', 12)],
    });
    const d = await service.adminDashboard();
    expect(d.money.map((m) => m.currency)).toEqual(['INR', 'USD']);
    expect(d.money[1]).toEqual({ ...zero('USD', 'US'), totalBookings: 12 });
  });

  it('lists a market that so far only has venues, with every figure zero', async () => {
    const { service } = setup([], [], {
      // Whatever an organizer typed: aliases reach one market, and an unknown country none.
      venues: [
        { country: 'India' },
        { country: 'United States' },
        { country: 'USA' },
        { country: 'Canada' },
        { country: 'Atlantis' },
      ],
    });
    const d = await service.adminDashboard();
    expect(d.money).toEqual([zero('CAD', 'CA'), zero('INR', 'IN'), zero('USD', 'US')]);
  });

  it('counts payment failures per market, not across the platform', async () => {
    const { service, prisma } = setup([], [], {
      all: [all('INR', 30), all('USD', 11)],
      failures: [
        { currency: 'INR', count: BigInt(19) },
        { currency: 'USD', count: BigInt(3) },
      ],
    });
    const d = await service.adminDashboard();
    expect(d.money.map((m) => [m.currency, m.paymentFailures])).toEqual([
      ['INR', 19],
      ['USD', 3],
    ]);
    // Postgres refuses an enum column compared to a bound text parameter; the literal must stay.
    const failureSql = prisma.$queryRaw.mock.calls
      .map(([sql]) => sql.join('?'))
      .find((sql) => sql.includes('"Payment"'));
    expect(failureSql).toContain(`p."status" = 'FAILED'`);
    expect(failureSql).toContain('JOIN "Booking" b');
  });

  it('puts markets that have sold before markets that have not, whatever the alphabet says', async () => {
    // USD's four bookings were free — no money, but sold — so it still outranks an empty CAD.
    const { service } = setup([row('INR', 50_000, 0, 0, 1), row('USD', 0, 0, 0, 4)], [], {
      all: [all('CAD', 3), all('INR', 1), all('USD', 4)],
      venues: [{ country: 'Canada' }],
    });
    const d = await service.adminDashboard();
    expect(d.money.map((m) => m.currency)).toEqual(['INR', 'USD', 'CAD']);
  });

  it('keeps the platform-wide totals older clients still read', async () => {
    const { service } = setup([row('INR', 1_000, 10, 5, 1), row('USD', 2_000, 20, 0, 1)], [], {
      all: [all('INR', 1), all('USD', 1)],
      failures: [{ currency: 'USD', count: 1 }],
    });
    const d = await service.adminDashboard();
    expect(d).toMatchObject({
      gmvMinor: 3_000,
      platformRevenueMinor: 35,
      refundVolumeMinor: 0,
      totalBookings: 40,
      paymentFailures: 2,
    });
  });
});
