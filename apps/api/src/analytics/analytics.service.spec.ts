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
    // top-events rows
    return Promise.resolve([
      { eventId: 'e1', _sum: { subtotalMinor: 50000 }, _count: { _all: 3 } },
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
    $queryRaw: jest.fn().mockResolvedValue([]),
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

    expect(r.revenue?.grossMinor).toBe(100000);
    // net = gross - organizerFee - refunds = 100000 - 3000 - 10000
    expect(r.revenue?.netMinor).toBe(87000);
    // refundRate = refundAmount / gross = 10000 / 100000 = 10%
    expect(r.refunds).toEqual({ count: 2, amountMinor: 10000, refundRate: 10 });
    expect(r.coupons).toEqual({ redemptions: 4, discountMinor: 1000 });
  });

  it('gates financial fields: a non-OWNER/MANAGER member sees no money and money queries never run', async () => {
    const { service, prisma } = makeService({ membershipRole: 'CHECKIN_STAFF' });
    const r = await service.organizer(owner, 'o1');

    expect(r.revenue).toBeUndefined();
    expect(r.refunds).toBeUndefined();
    expect(r.coupons).toBeUndefined();
    // Non-financial metrics still present.
    expect(r.attendance.issued).toBe(10);
    // The revenue/refund aggregates must not be issued at all.
    expect(prisma.booking.aggregate).not.toHaveBeenCalled();
    expect(prisma.refund.aggregate).not.toHaveBeenCalled();
  });

  it('grants financial fields to platform admins regardless of membership', async () => {
    const { service, prisma } = makeService({ isAdmin: true, membershipRole: null });
    const r = await service.organizer(owner, 'o1');
    expect(r.revenue?.grossMinor).toBe(100000);
    expect(prisma.organizationMember.findUnique).not.toHaveBeenCalled();
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
    expect(r.revenue.grossMinor).toBe(100000);
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
