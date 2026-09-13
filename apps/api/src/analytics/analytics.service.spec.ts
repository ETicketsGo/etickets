import { AnalyticsService } from './analytics.service';

const owner = { id: 'u-owner', roles: [] } as never;

/** Grouped rows are keyed by the `by` field so one mock serves several helpers. */
function bookingGroupBy(args: { by: string[] }) {
  if (args.by[0] === 'status') {
    return Promise.resolve([
      { status: 'CONFIRMED', _count: { _all: 6 } },
      { status: 'EXPIRED', _count: { _all: 4 } },
    ]);
  }
  if (args.by[0] === 'eventId') {
    // top-events rows, now carrying the currency the event sold in
    return Promise.resolve([
      { eventId: 'e1', currency: 'INR', _sum: { subtotalMinor: 50000 }, _count: { _all: 3 } },
    ]);
  }
  if (args.by[0] === 'currency') {
    // revenueByCurrency / couponRedemptions
    return Promise.resolve([
      {
        currency: 'INR',
        _sum: {
          subtotalMinor: 100000,
          bookingFeeMinor: 5000,
          paymentFeeMinor: 2000,
          organizerFeeMinor: 3000,
          discountMinor: 1000,
        },
        _count: { _all: 4 },
      },
    ]);
  }
  // by userId → repeat-visitor rows (one per customer)
  return Promise.resolve([
    { userId: 'c1', _count: { _all: 2 } },
    { userId: 'c2', _count: { _all: 1 } },
    { userId: 'c3', _count: { _all: 3 } },
  ]);
}

function makeService(
  opts: {
    isAdmin?: boolean;
    membershipRole?: string | null;
    prisma?: Record<string, unknown>;
    adminDashboard?: Record<string, unknown>;
  } = {},
) {
  const prisma = {
    booking: {
      aggregate: jest.fn().mockResolvedValue({
        _sum: {
          subtotalMinor: 100000,
          bookingFeeMinor: 5000,
          paymentFeeMinor: 2000,
          organizerFeeMinor: 3000,
          discountMinor: 1000,
        },
        _count: 6,
      }),
      groupBy: jest.fn(bookingGroupBy),
      count: jest.fn().mockResolvedValue(4),
    },
    refund: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { amountMinor: 10000 }, _count: 2 }),
    },
    ticket: {
      groupBy: jest.fn().mockResolvedValue([
        { status: 'ACTIVE', _count: { _all: 8 } },
        { status: 'CHECKED_IN', _count: { _all: 2 } },
      ]),
    },
    bookingItem: {
      groupBy: jest.fn().mockResolvedValue([{ ticketTypeId: 'tt1', _sum: { quantity: 5 } }]),
    },
    ticketType: { findUnique: jest.fn().mockResolvedValue({ name: 'VIP' }) },
    organizationMember: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          opts.membershipRole === null
            ? null
            : { role: opts.membershipRole ?? 'ORGANIZER_OWNER', status: 'ACTIVE' },
        ),
    },
    venue: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'v1', name: 'Hall', city: 'BLR', organizationId: 'o1' }),
      // An Indian venue that sells, and a US one that has not sold yet.
      findMany: jest.fn().mockResolvedValue([{ country: 'India' }, { country: 'United States' }]),
    },
    event: {
      count: jest.fn().mockResolvedValue(3),
      findMany: jest.fn().mockResolvedValue([{ id: 'e1', title: 'Concert' }]),
    },
    eventSession: { count: jest.fn().mockResolvedValue(5) },
    showSeat: {
      groupBy: jest.fn().mockResolvedValue([
        { status: 'SOLD', _count: { _all: 30 } },
        { status: 'AVAILABLE', _count: { _all: 70 } },
      ]),
    },
    ticketInventory: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { quantityTotal: 200, quantitySold: 50 } }),
    },
    /*
      Two raw joins run for an organizer with financial access, in this order: refunds by the
      booking's currency, then the country split. Prisma cannot group by a relation field, so
      both are hand-written SQL rather than `groupBy`.
    */
    $queryRaw: jest
      .fn()
      .mockResolvedValueOnce([{ currency: 'INR', count: 2n, amount: 10000n }])
      .mockResolvedValueOnce([{ country: 'India', currency: 'INR', gross: 100000n, bookings: 4n }])
      .mockResolvedValue([]),
    ...(opts.prisma ?? {}),
  };
  const access = {
    isPlatformAdmin: jest.fn().mockReturnValue(opts.isAdmin ?? false),
    assertMember: jest.fn().mockResolvedValue(undefined),
  };
  const reports = {
    adminDashboard: jest.fn().mockResolvedValue({
      gmvMinor: 500000,
      platformRevenueMinor: 20000,
      totalBookings: 100,
      confirmedBookings: 70,
      ...(opts.adminDashboard ?? {}),
    }),
  };
  return {
    prisma,
    access,
    reports,
    service: new AnalyticsService(prisma as never, access as never, reports as never),
  };
}

describe('AnalyticsService.organizer', () => {
  it('composes attendance, conversion and repeat-visitor metrics from grouped aggregates', async () => {
    const { service } = makeService();
    const r = await service.organizer(owner, 'o1');

    // attendance: issued = ACTIVE + CHECKED_IN, rate = checkedIn/issued
    expect(r.attendance).toEqual({ issued: 10, checkedIn: 2, checkInRate: 20 });
    // conversion: confirmed / total(incl. expired)
    expect(r.conversion).toEqual({ total: 10, confirmed: 6, rate: 60 });
    // repeat visitors: 2 of 3 customers have >1 confirmed booking
    expect(r.repeatVisitors).toEqual({ totalCustomers: 3, repeatCustomers: 2, rate: 67 });
    expect(r.topTicketType).toEqual({ name: 'VIP', quantity: 5 });
  });

  it('includes financial fields with correct refund%/net for OWNER and computes net after refunds', async () => {
    const { service } = makeService({ membershipRole: 'ORGANIZER_MANAGER' });
    const r = await service.organizer(owner, 'o1');

    /*
      One block per currency. An organizer selling only in India sees exactly one, which is
      what they always saw — the difference is that a second country now produces a second
      block rather than being added into this one.
    */
    expect(r.revenue).toHaveLength(1);
    expect(r.revenue?.[0].currency).toBe('INR');
    expect(r.revenue?.[0].grossMinor).toBe(100000);
    // net = gross - organizerFee - refunds = 100000 - 3000 - 10000
    expect(r.revenue?.[0].netMinor).toBe(87000);
    // refundRate = refundAmount / gross = 10000 / 100000 = 10%
    expect(r.refunds).toEqual([{ currency: 'INR', count: 2, amountMinor: 10000, refundRate: 10 }]);
    expect(r.coupons).toEqual([{ currency: 'INR', redemptions: 4, discountMinor: 1000 }]);
  });

  it('gates financial fields: a non-OWNER/MANAGER member sees no money and money queries never run', async () => {
    const { service, prisma } = makeService({ membershipRole: 'CHECKIN_STAFF' });
    const r = await service.organizer(owner, 'o1');

    expect(r.revenue).toBeUndefined();
    expect(r.refunds).toBeUndefined();
    expect(r.coupons).toBeUndefined();
    expect(r.markets).toBeUndefined();
    // Non-financial metrics still present.
    expect(r.attendance.issued).toBe(10);
    // The revenue/refund aggregates must not be issued at all.
    expect(prisma.booking.aggregate).not.toHaveBeenCalled();
    // Refunds, the country split and payment failures are raw joins; none may run for this role.
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.venue.findMany).not.toHaveBeenCalled();
  });

  /*
    Reported by the owner: the admin dashboard shows payments by country and the organizer's did
    not. Every market is listed — one that has sold nothing too — with its payments beside it.
  */
  it('lists every market with its payments, including a country that has not sold yet', async () => {
    const $queryRaw = jest.fn((strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('"Refund"')) {
        return Promise.resolve([{ currency: 'INR', count: 2n, amount: 10000n }]);
      }
      if (sql.includes('"Venue"')) {
        return Promise.resolve([
          { country: 'India', currency: 'INR', gross: 100000n, bookings: 4n },
        ]);
      }
      if (sql.includes('"Payment"')) {
        return Promise.resolve([
          { currency: 'INR', count: 3n },
          { currency: 'usd', count: 2n },
        ]);
      }
      return Promise.resolve([]);
    });
    const { service } = makeService({ prisma: { $queryRaw } });
    const r = await service.organizer(owner, 'o1');

    expect(r.markets).toEqual([
      {
        country: 'IN',
        currency: 'INR',
        grossMinor: 100000,
        netMinor: 87000,
        refundsMinor: 10000,
        paidBookings: 4,
        totalBookings: 4,
        paymentFailures: 3,
      },
      {
        country: 'US',
        currency: 'USD',
        grossMinor: 0,
        netMinor: 0,
        refundsMinor: 0,
        paidBookings: 0,
        totalBookings: 0,
        paymentFailures: 2,
      },
    ]);

    // Failures are this organization's, and the status is a literal (an enum refuses a bound text).
    const failures = $queryRaw.mock.calls.find(([strings]) =>
      strings.join('?').includes('"Payment"'),
    ) as unknown as [TemplateStringsArray, ...unknown[]];
    expect(failures[0].join('?')).toContain(`p."status" = 'FAILED'`);
    expect(failures.slice(1)).toEqual(['o1']);
  });

  it('grants financial fields to platform admins regardless of membership', async () => {
    const { service, prisma } = makeService({ isAdmin: true, membershipRole: null });
    const r = await service.organizer(owner, 'o1');
    expect(r.revenue?.[0].grossMinor).toBe(100000);
    expect(prisma.organizationMember.findUnique).not.toHaveBeenCalled();
  });
});

/**
 * The grouping itself, not a caller's mock of it.
 *
 * ── WHY THIS TEST EXISTS ───────────────────────────────────────────────────────────
 * The multi-currency report test mocks `revenueByCurrency` and asserts the caller keeps two
 * blocks apart. That is worth having and it does not touch this function — hardcoding
 * `currency: 'INR'` here passed every one of those tests, because every fixture above happens
 * to be Indian. A guarantee is only tested where it is implemented.
 */
describe('AnalyticsService.revenueByCurrency', () => {
  it('labels each block with the currency it was actually taken in', async () => {
    const { service } = makeService({
      prisma: {
        booking: {
          groupBy: jest.fn().mockResolvedValue([
            {
              currency: 'USD',
              _sum: {
                subtotalMinor: 2000,
                bookingFeeMinor: 99,
                paymentFeeMinor: 42,
                organizerFeeMinor: 0,
                discountMinor: 0,
              },
              _count: { _all: 1 },
            },
            {
              currency: 'INR',
              _sum: {
                subtotalMinor: 79900,
                bookingFeeMinor: 1500,
                paymentFeeMinor: 1628,
                organizerFeeMinor: 500,
                discountMinor: 0,
              },
              _count: { _all: 4 },
            },
          ]),
        },
      },
    });

    const rows = await service.revenueByCurrency({ organizationId: 'o1' });

    // Two blocks, each carrying its OWN currency — not one label applied to both.
    expect(rows.map((r) => r.currency).sort()).toEqual(['INR', 'USD']);
    expect(rows.find((r) => r.currency === 'USD')?.grossMinor).toBe(2000);
    expect(rows.find((r) => r.currency === 'INR')?.grossMinor).toBe(79900);
    // Largest first, within the list — never summed into one figure.
    expect(rows[0].currency).toBe('INR');
    expect(rows.reduce((n, r) => n + r.grossMinor, 0)).toBe(81900);
    // …and that 81900 is deliberately not something the function itself ever returns.
    expect(rows).toHaveLength(2);
  });

  it('asks the database to group by currency, so the split is not done in memory', async () => {
    const { service, prisma } = makeService();
    await service.revenueByCurrency({ organizationId: 'o1' });
    expect(prisma.booking.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ by: ['currency'] }),
    );
  });
});

describe('AnalyticsService.venue', () => {
  it('combines seat + general-admission occupancy and venue revenue', async () => {
    const { service } = makeService();
    const r = await service.venue(owner, 'v1');

    expect(r.utilization).toEqual({ events: 3, sessions: 5 });
    // seats 30/100 + GA 50/200 → 80/300
    expect(r.occupancy.sold).toBe(80);
    expect(r.occupancy.capacity).toBe(300);
    expect(r.occupancy.occupancyRate).toBe(27);
    expect(r.revenue?.grossMinor).toBe(100000);
  });

  it('withholds revenue from a member who may not see money, and never runs the query', async () => {
    /*
      The organization dashboard already withheld money from check-in staff; this endpoint
      handed them the same venue's gross and net on membership alone.
    */
    const { service, prisma } = makeService({ membershipRole: 'CHECKIN_STAFF' });
    const r = await service.venue(owner, 'v1');

    // Operational figures are still theirs to see.
    expect(r.occupancy.sold).toBe(80);
    expect(r).not.toHaveProperty('revenue');
    expect(prisma.booking.aggregate).not.toHaveBeenCalled();
  });

  it('shows revenue to a manager and to a platform admin', async () => {
    const manager = await makeService({ membershipRole: 'ORGANIZER_MANAGER' }).service.venue(
      owner,
      'v1',
    );
    expect(manager.revenue?.grossMinor).toBe(100000);
    const admin = await makeService({ isAdmin: true, membershipRole: null }).service.venue(
      owner,
      'v1',
    );
    expect(admin.revenue?.grossMinor).toBe(100000);
  });
});

describe('AnalyticsService.platform', () => {
  it('reuses the admin dashboard and extends it with funnel + retention', async () => {
    const { service, prisma } = makeService();
    // movies published, events published
    prisma.event.count = jest.fn().mockResolvedValueOnce(4).mockResolvedValueOnce(9);
    prisma.booking.count = jest.fn().mockResolvedValue(40); // checked-in bookings
    const r = await service.platform();

    expect(r.gmvMinor).toBe(500000);
    expect(r.moviesCount).toBe(4);
    expect(r.eventsCount).toBe(9);
    expect(r.funnel).toEqual({ created: 100, confirmed: 70, checkedIn: 40 });
    expect(r.retention.rate).toBe(67);
  });
});

describe('AnalyticsService.customer', () => {
  it('splits upcoming vs past bookings and maps favourites without fabricating collections', async () => {
    const { service, prisma } = makeService();
    prisma.booking.count = jest.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(3);
    prisma.$queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'o1', name: 'Org', bookings: 5n }])
      .mockResolvedValueOnce([{ id: 'v1', name: 'Hall', city: 'BLR', bookings: 4n }]);
    const r = await service.customer(owner);

    expect(r.bookings).toEqual({ upcoming: 2, past: 3, total: 5 });
    expect(r.favoriteOrganizers).toEqual([{ id: 'o1', name: 'Org', bookings: 5 }]);
    expect(r.favoriteVenues).toEqual([{ id: 'v1', name: 'Hall', city: 'BLR', bookings: 4 }]);
    expect(r.collectionsNote).toMatch(/client-side/i);
  });
});
