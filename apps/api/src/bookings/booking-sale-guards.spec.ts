import { BookingsService } from './bookings.service';

/**
 * What the booking path must refuse to sell, and a discount it must refuse to give.
 *
 * Three facts were on file and not read at checkout: a ticket type the organizer had taken
 * off sale (`status`), a session that has already started (nothing marks a past date of a
 * run COMPLETED, so it still reads SCHEDULED), and which organization a discount code
 * belongs to — so one organizer's 100% code discounted another organizer's tickets.
 */
const IN_THREE_DAYS = () => new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
const A_MINUTE_AGO = () => new Date(Date.now() - 60 * 1000);

function coupon(organizationId: string | null) {
  return {
    id: `cp-${organizationId ?? 'platform'}`,
    organizationId,
    code: 'TENOFF',
    status: 'ACTIVE',
    type: 'PERCENT',
    value: 10,
    startsAt: null,
    endsAt: null,
    maxRedemptions: null,
    redemptions: 0,
  };
}

function setup(over: { startsAt?: Date; ticketStatus?: string; coupon?: unknown } = {}) {
  const session = {
    id: 'sess-1',
    eventId: 'ev-1',
    screenId: null,
    startsAt: over.startsAt ?? IN_THREE_DAYS(),
    status: 'SCHEDULED',
    event: {
      id: 'ev-1',
      organizationId: 'org-1',
      status: 'PUBLISHED',
      experienceType: 'EVENT',
      feeMode: 'CUSTOMER_PAYS',
      isFree: false,
      category: 'Music',
      venue: { country: 'India', region: 'Karnataka', city: 'Bengaluru' },
      organization: {
        registeredCountry: 'India',
        registeredRegion: 'Karnataka',
        cashPaymentsEnabled: false,
      },
    },
    screen: null,
  };
  const ticketType = {
    id: 'tt-1',
    eventSessionId: 'sess-1',
    name: 'General',
    priceMinor: 50_000,
    currency: 'INR',
    maxPerOrder: 10,
    salesStartAt: null,
    salesEndAt: null,
    status: over.ticketStatus ?? 'ACTIVE',
    seatCategoryId: null,
    seatCategory: null,
  };
  const prisma = {
    eventSession: { findUnique: jest.fn().mockResolvedValue(session) },
    ticketType: { findMany: jest.fn().mockResolvedValue([ticketType]) },
    // The lazy expiry sweep `create` runs first; nothing stale here.
    booking: { findMany: jest.fn().mockResolvedValue([]) },
    coupon: { findUnique: jest.fn().mockResolvedValue(over.coupon ?? null) },
    $transaction: jest.fn(),
  };
  const pricingStrategies = {
    quote: jest.fn().mockReturnValue({
      subtotalMinor: 100_000,
      lines: [
        { ticketTypeId: 'tt-1', quantity: 2, unitPriceMinor: 50_000, lineTotalMinor: 100_000 },
      ],
    }),
  };
  const pricing = {
    quote: jest
      .fn()
      .mockImplementation(async (subtotal: number, _mode: string, discount: number, currency) => ({
        currency,
        subtotalMinor: subtotal,
        discountMinor: discount,
        netSubtotalMinor: subtotal - discount,
        bookingFeeMinor: 0,
        paymentFeeMinor: 0,
        customerFeeMinor: 0,
        organizerFeeMinor: 0,
        taxLines: [],
        taxMinor: 0,
        totalMinor: subtotal - discount,
      })),
  };
  const stub = {} as never;
  const service = new BookingsService(
    prisma as never,
    pricing as never,
    pricingStrategies as never,
    { record: jest.fn().mockResolvedValue(undefined) } as never, // audit
    stub, // inventory
    stub, // addOnInventory
    stub, // metrics
    stub, // lockShadow
    stub, // bookingShadow
  );
  return { service, prisma, pricing };
}

const cart = (couponCode?: string) =>
  ({
    eventSessionId: 'sess-1',
    buyerName: 'B',
    buyerEmail: 'b@t.test',
    items: [{ ticketTypeId: 'tt-1', quantity: 2 }],
    ...(couponCode ? { couponCode } : {}),
  }) as never;

describe('a ticket type taken off sale', () => {
  it('cannot be booked', async () => {
    const { service, prisma } = setup({ ticketStatus: 'INACTIVE' });
    await expect(service.create(null, cart())).rejects.toThrow(/General is not on sale/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('cannot be quoted', async () => {
    const { service, pricing } = setup({ ticketStatus: 'INACTIVE' });
    await expect(service.quote(cart())).rejects.toThrow(/General is not on sale/);
    expect(pricing.quote).not.toHaveBeenCalled();
  });
});

describe('a session that has already started', () => {
  it('cannot be booked, even though it still reads SCHEDULED', async () => {
    const { service, prisma } = setup({ startsAt: A_MINUTE_AGO() });
    await expect(service.create(null, cart())).rejects.toThrow(/already started/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('cannot be quoted', async () => {
    const { service, pricing } = setup({ startsAt: A_MINUTE_AGO() });
    await expect(service.quote(cart())).rejects.toThrow(/already started/);
    expect(pricing.quote).not.toHaveBeenCalled();
  });

  it('a future session still quotes', async () => {
    const { service } = setup();
    await expect(service.quote(cart())).resolves.toMatchObject({ fees: { totalMinor: 100_000 } });
  });
});

describe('a discount code from another organization', () => {
  it('is not applied to this organization’s tickets', async () => {
    const { service, pricing } = setup({ coupon: coupon('org-2') });
    const res = await service.quote(cart('TENOFF'));

    expect(res.coupon).toEqual({ code: 'TENOFF', applied: false });
    // No discount reached the price.
    expect(pricing.quote.mock.calls[0][2]).toBe(0);
  });

  it('is applied when it is the selling organization’s own', async () => {
    const { service, pricing } = setup({ coupon: coupon('org-1') });
    const res = await service.quote(cart('TENOFF'));

    expect(res.coupon).toEqual({ code: 'TENOFF', applied: true });
    expect(pricing.quote.mock.calls[0][2]).toBe(10_000);
  });

  it('is applied when it is platform-wide', async () => {
    const { service } = setup({ coupon: coupon(null) });
    const res = await service.quote(cart('TENOFF'));
    expect(res.coupon.applied).toBe(true);
  });
});
