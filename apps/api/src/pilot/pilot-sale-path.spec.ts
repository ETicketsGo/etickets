import { BookingsService } from '../bookings/bookings.service';
import { PaymentsService } from '../payments/payments.service';
import { SALE_NOT_OPEN_REASON } from '../pricing/cinema-policy/sale-eligibility';
import type { PilotEnv } from './pilot-config';
import { PilotGuardService } from './pilot-guard.service';

/**
 * The pilot's limits on the real sale path: quote, booking create (guest and signed in) and
 * payment start. Collaborators are stubbed so a sale that gets past every check stops at the
 * booking row, before anything is held.
 *
 * Fails on the code before this change: there, nothing but `maxPerOrder` limited a sale, so
 * every "refuses" case below reached the booking row.
 */
const IN_THREE_DAYS = () => new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
const PILOT_ORG = 'org-pilot';
const SIGNED_IN = { id: 'u1', email: 'buyer@example.test', fullName: 'B', roles: [] } as never;

const PILOT: PilotEnv = {
  PILOT_MODE: 'on',
  PILOT_ALLOWED_ORGANIZATION_IDS: PILOT_ORG,
  PILOT_MAX_ORDER_MINOR: '200000',
  PILOT_MAX_DAILY_SALES_MINOR: '2500000',
};

/** The env a ConfigService would hand the guard. A Razorpay key, so INR routes to Razorpay. */
function guard(env: PilotEnv | null, countedToday = 0, extra: Record<string, string> = {}) {
  const values: Record<string, string | undefined> = {
    RAZORPAY_KEY_ID: 'rzp_test_x',
    PAYMENT_PROVIDER_NAME: 'mock',
    ...(env ?? {}),
    ...extra,
  };
  const aggregate = jest.fn().mockResolvedValue({ _sum: { totalMinor: countedToday } });
  const prisma = {
    booking: { aggregate },
    auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const service = new PilotGuardService(
    prisma as never,
    { get: (k: string) => values[k] } as never,
  );
  return { service, aggregate };
}

interface Over {
  organizationId?: string;
  screenId?: string | null;
  seatMapId?: string | null;
  experienceType?: string;
  currency?: string;
}

function setup(pilot: PilotGuardService | undefined, over: Over = {}, countedToday = 0) {
  const session = {
    id: 'sess-1',
    eventId: 'ev-1',
    screenId: over.screenId ?? null,
    seatMapId: over.seatMapId ?? null,
    startsAt: IN_THREE_DAYS(),
    status: 'SCHEDULED',
    event: {
      id: 'ev-1',
      organizationId: over.organizationId ?? PILOT_ORG,
      status: 'PUBLISHED',
      experienceType: over.experienceType ?? 'EVENT',
      feeMode: 'CUSTOMER_PAYS',
      isFree: false,
      category: 'Music',
      venue: { country: 'India', region: 'Karnataka', city: 'Bengaluru' },
      organization: {
        registeredCountry: 'India',
        registeredRegion: 'Karnataka',
        cashPaymentsEnabled: true,
        name: 'Aurora Live',
        status: 'APPROVED',
      },
    },
    screen: null,
  };
  const ticketType = {
    id: 'tt-1',
    eventSessionId: 'sess-1',
    name: 'General',
    priceMinor: 50_000,
    currency: over.currency ?? 'INR',
    maxPerOrder: 10,
    salesStartAt: null,
    salesEndAt: null,
    status: 'ACTIVE',
    seatCategoryId: null,
    seatCategory: null,
  };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ locked: 1 }]),
    booking: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { totalMinor: countedToday } }),
      create: jest.fn().mockRejectedValue(new Error('REACHED_BOOKING_ROW')),
    },
  };
  const prisma = {
    eventSession: { findUnique: jest.fn().mockResolvedValue(session) },
    ticketType: { findMany: jest.fn().mockResolvedValue([ticketType]) },
    booking: { findMany: jest.fn().mockResolvedValue([]) },
    seat: { findMany: jest.fn().mockResolvedValue([{ id: 'seat-1', seatCategoryId: null }]) },
    coupon: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const pricingStrategies = {
    quote: jest.fn().mockImplementation((ctx: { lines: { quantity: number }[] }) => {
      const q = ctx.lines.reduce((s, l) => s + l.quantity, 0);
      return {
        subtotalMinor: 50_000 * q,
        lines: [
          { ticketTypeId: 'tt-1', quantity: q, unitPriceMinor: 50_000, lineTotalMinor: 50_000 * q },
        ],
      };
    }),
  };
  const pricing = {
    quote: jest
      .fn()
      .mockImplementation(async (subtotal: number, _m: string, discount: number, currency) => ({
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
    { record: jest.fn().mockResolvedValue(undefined) } as never,
    { forSeating: () => ({ reserve: jest.fn() }) } as never,
    stub,
    stub,
    stub,
    stub,
    undefined,
    undefined,
    undefined,
    undefined,
    pilot,
  );
  return { service, prisma, tx, pricing };
}

const cart = (
  over: { quantity?: number; buyerEmail?: string; seatIds?: string[]; cash?: boolean } = {},
) =>
  ({
    eventSessionId: 'sess-1',
    buyerName: 'B',
    buyerEmail: over.buyerEmail ?? 'buyer@example.test',
    items: [
      {
        ticketTypeId: 'tt-1',
        quantity: over.quantity ?? 2,
        ...(over.seatIds ? { seatIds: over.seatIds } : {}),
      },
    ],
    ...(over.cash ? { paymentMethod: 'CASH' } : {}),
  }) as never;

type Outcome = 'SOLD' | { blockers: string[] } | string;

async function outcome(p: Promise<unknown>): Promise<Outcome> {
  try {
    await p;
    return 'SOLD';
  } catch (e) {
    const err = e as { message?: string; details?: { reason?: string; blockers?: string[] } };
    if (err.message === 'REACHED_BOOKING_ROW') return 'SOLD';
    if (err.details?.reason === SALE_NOT_OPEN_REASON) return { blockers: err.details.blockers! };
    return String(err.message);
  }
}

/** Quote, guest create and signed-in create, side by side. */
async function allThree(pilot: PilotGuardService | undefined, over: Over = {}, c = cart()) {
  const run = () => setup(pilot, over);
  return {
    quote: await outcome(run().service.quote(c)),
    guest: await outcome(run().service.create(null, c)),
    signedIn: await outcome(run().service.create(SIGNED_IN, c)),
  };
}

describe('pilot off', () => {
  it.each([
    ['PILOT_MODE unset', guard(null).service],
    ['PILOT_MODE=off', guard({ ...PILOT, PILOT_MODE: 'off' }).service],
    ['no pilot guard at all', undefined],
  ])('%s: sells exactly what it sold before, to any organizer, any currency', async (_l, g) => {
    for (const over of [
      {},
      { organizationId: 'org-other' },
      { seatMapId: 'sm-1' },
      { currency: 'USD' },
    ]) {
      expect(await allThree(g, over, cart({ quantity: 9 }))).toEqual({
        quote: 'SOLD',
        guest: 'SOLD',
        signedIn: 'SOLD',
      });
    }
  });

  it('quotes the identical price with the guard off as without it', async () => {
    const without = await setup(undefined).service.quote(cart());
    const off = await setup(guard(null).service).service.quote(cart());
    expect(off).toEqual(without);
  });

  it('takes no lock and counts nothing', async () => {
    const { service, tx } = setup(guard(null).service);
    await outcome(service.create(null, cart()));
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.booking.aggregate).not.toHaveBeenCalled();
  });
});

describe('pilot on: what sells', () => {
  it('sells a Rs 1,000 general-admission INR order for the pilot organizer', async () => {
    expect(await allThree(guard(PILOT).service)).toEqual({
      quote: 'SOLD',
      guest: 'SOLD',
      signedIn: 'SOLD',
    });
  });

  it('takes the pilot lock inside the booking transaction, before the booking row', async () => {
    const { service, tx } = setup(guard(PILOT).service);
    await outcome(service.create(null, cart()));
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.booking.aggregate.mock.invocationCallOrder[0]).toBeLessThan(
      tx.booking.create.mock.invocationCallOrder[0],
    );
  });
});

describe('pilot on: each refusal, with quote and create agreeing', () => {
  it.each<[string, Over, ReturnType<typeof cart>, string, Record<string, string>]>([
    [
      'another organizer',
      { organizationId: 'org-other' },
      cart(),
      'PILOT_ORGANIZER_NOT_ALLOWED',
      {},
    ],
    ['a session with a seat map', { seatMapId: 'sm-1' }, cart(), 'PILOT_RESERVED_SEATING', {}],
    [
      'a session in a seated room',
      { screenId: 'scr-1' },
      cart({ quantity: 1, seatIds: ['seat-1'] }),
      'PILOT_RESERVED_SEATING',
      {},
    ],
    ['a cinema show', { experienceType: 'MOVIE' }, cart(), 'PILOT_RESERVED_SEATING', {}],
    ['a dollar-priced ticket', { currency: 'USD' }, cart(), 'PILOT_CURRENCY', {}],
    ['an order over Rs 2,000', {}, cart({ quantity: 5 }), 'PILOT_ORDER_LIMIT', {}],
    [
      'INR that would not go to Razorpay (no Razorpay key)',
      {},
      cart(),
      'PILOT_PROVIDER',
      { RAZORPAY_KEY_ID: '' },
    ],
  ])('%s', async (_l, over, c, code, extra) => {
    const result = await allThree(guard(PILOT, 0, extra).service, over, c);
    expect(result.quote).toEqual({ blockers: expect.arrayContaining([code]) });
    // Quote = create, for the guest and for a signed-in buyer.
    expect(result.guest).toEqual(result.quote);
    expect(result.signedIn).toEqual(result.quote);
  });

  it('refuses cash at the venue on create', async () => {
    const { service } = setup(guard(PILOT).service);
    expect(await outcome(service.create(null, cart({ cash: true })))).toEqual({
      blockers: ['PILOT_PROVIDER'],
    });
  });

  it('answers with the SALE_NOT_OPEN shape the storefront already translates', async () => {
    const { service } = setup(guard(PILOT).service, { organizationId: 'org-other' });
    await expect(service.quote(cart())).rejects.toMatchObject({
      status: 409,
      details: { reason: 'SALE_NOT_OPEN', blockers: ['PILOT_ORGANIZER_NOT_ALLOWED'] },
    });
  });

  it('refuses before any stock is touched', async () => {
    const { service, prisma } = setup(guard(PILOT).service, { organizationId: 'org-other' });
    await outcome(service.create(null, cart()));
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('pilot on: the daily cap', () => {
  it('quote and create both refuse the order that would pass Rs 25,000 today', async () => {
    // Rs 24,500 already counted; this Rs 1,000 order would make Rs 25,500.
    const g = guard(PILOT, 2_450_000).service;
    expect(await outcome(setup(g, {}, 2_450_000).service.quote(cart()))).toEqual({
      blockers: ['PILOT_DAILY_LIMIT'],
    });
    expect(await outcome(setup(g, {}, 2_450_000).service.create(null, cart()))).toEqual({
      blockers: ['PILOT_DAILY_LIMIT'],
    });
  });

  it('sells the order that lands exactly on the cap', async () => {
    const g = guard(PILOT, 2_400_000).service;
    expect(await outcome(setup(g, {}, 2_400_000).service.quote(cart()))).toBe('SOLD');
    expect(await outcome(setup(g, {}, 2_400_000).service.create(null, cart()))).toBe('SOLD');
  });

  it('counts paid bookings and unexpired holds of pilot organizers, in this currency, today', async () => {
    const { service, aggregate } = guard(PILOT);
    const now = new Date('2026-10-15T10:00:00Z');
    await service.countedToday(service['prisma'] as never, 'INR', now);
    expect(aggregate).toHaveBeenCalledWith({
      _sum: { totalMinor: true },
      where: {
        organizationId: { in: [PILOT_ORG] },
        currency: 'INR',
        createdAt: {
          gte: new Date('2026-10-14T18:30:00Z'),
          lt: new Date('2026-10-15T18:30:00Z'),
        },
        OR: [
          { status: { in: ['CONFIRMED', 'PARTIALLY_REFUNDED', 'DISPUTED'] } },
          // An expired hold is not counted, even before the sweep marks it EXPIRED.
          { status: 'PENDING_PAYMENT', holdExpiresAt: { gt: now } },
        ],
      },
    });
  });
});

describe('pilot on: the buyer allowlist', () => {
  const owner = () => guard({ ...PILOT, PILOT_ALLOWED_BUYER_EMAILS: 'owner@example.test' }).service;

  it('lets the listed buyer book as a guest and signed in', async () => {
    const g = owner();
    const c = cart({ buyerEmail: 'owner@example.test' });
    const ownerUser = { ...(SIGNED_IN as object), email: 'Owner@example.test' } as never;
    expect(await outcome(setup(g).service.create(null, c))).toBe('SOLD');
    expect(await outcome(setup(g).service.create(ownerUser, c))).toBe('SOLD');
  });

  it('refuses every other buyer at create', async () => {
    const r = await allThree(owner());
    expect(r.guest).toEqual({ blockers: ['PILOT_BUYER_NOT_ALLOWED'] });
    expect(r.signedIn).toEqual({ blockers: ['PILOT_BUYER_NOT_ALLOWED'] });
  });

  it('refuses a signed-in stranger who typed the owner address', async () => {
    const { service } = setup(owner());
    expect(
      await outcome(service.create(SIGNED_IN, cart({ buyerEmail: 'owner@example.test' }))),
    ).toEqual({ blockers: ['PILOT_BUYER_NOT_ALLOWED'] });
  });
});

describe('pilot on but misconfigured', () => {
  it.each([
    ['an empty organizer list', { PILOT_ALLOWED_ORGANIZATION_IDS: '' }],
    ['an unparseable order cap', { PILOT_MAX_ORDER_MINOR: 'Rs 2000' }],
    ['an unparseable daily cap', { PILOT_MAX_DAILY_SALES_MINOR: '25k' }],
  ])('%s: nothing is sellable, by anybody', async (_l, over) => {
    const r = await allThree(guard({ ...PILOT, ...over }).service);
    expect(r).toEqual({
      quote: { blockers: ['PILOT_MISCONFIGURED'] },
      guest: { blockers: ['PILOT_MISCONFIGURED'] },
      signedIn: { blockers: ['PILOT_MISCONFIGURED'] },
    });
  });

  it('says why on the readiness status, without failing', async () => {
    const { service } = guard({ ...PILOT, PILOT_MAX_ORDER_MINOR: 'Rs 2000' });
    await expect(service.status()).resolves.toMatchObject({
      mode: 'on',
      valid: false,
      problems: [expect.stringMatching(/PILOT_MAX_ORDER_MINOR/)],
    });
  });
});

/* ───────────────────────────── payment start ───────────────────────────── */

function payments(pilot: PilotGuardService | undefined, over: Record<string, unknown> = {}) {
  const booking = {
    id: 'b1',
    status: 'PENDING_PAYMENT',
    userId: null,
    holdExpiresAt: new Date(Date.now() + 600_000),
    currency: 'INR',
    totalMinor: 100_000,
    subtotalMinor: 100_000,
    organizerFeeMinor: 0,
    discountMinor: 0,
    seatBased: false,
    paymentMethod: 'ONLINE',
    buyerName: 'B',
    buyerEmail: 'buyer@example.test',
    eventId: 'ev-1',
    payment: { id: 'pay-1' },
    event: {
      organizationId: PILOT_ORG,
      isFree: false,
      venue: { country: 'IN' },
      status: 'PUBLISHED',
      experienceType: 'EVENT',
    },
    eventSession: { status: 'SCHEDULED', startsAt: IN_THREE_DAYS() },
    ...over,
  };
  const prisma = {
    booking: { findUnique: jest.fn().mockResolvedValue(booking) },
    payment: { update: jest.fn().mockResolvedValue({}) },
  };
  const razorpayOrders = { createOrder: jest.fn().mockResolvedValue({ provider: 'razorpay' }) };
  const config = {
    get: (k: string) => ({ RAZORPAY_KEY_ID: 'rzp_test_x', APP_ENV: 'LOCAL' })[k as 'APP_ENV'],
  };
  const stub = {} as never;
  const service = new PaymentsService(
    prisma as never,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    config as never,
    stub,
    razorpayOrders as never,
    stub,
    stub,
    undefined,
    undefined,
    pilot,
  );
  return { service, razorpayOrders };
}

describe('pilot on: payment start', () => {
  it('opens the Razorpay order for a pilot booking', async () => {
    const { service, razorpayOrders } = payments(guard(PILOT).service);
    await service.createIntent('b1');
    expect(razorpayOrders.createOrder).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Record<string, unknown>, string]>([
    [
      'an event paused after the hold was made',
      {
        event: {
          organizationId: PILOT_ORG,
          isFree: false,
          venue: { country: 'IN' },
          status: 'PAUSED',
          experienceType: 'EVENT',
        },
      },
      'PILOT_EVENT_NOT_ON_SALE',
    ],
    [
      'another organizer',
      {
        event: {
          organizationId: 'org-other',
          isFree: false,
          venue: { country: 'IN' },
          status: 'PUBLISHED',
          experienceType: 'EVENT',
        },
      },
      'PILOT_ORGANIZER_NOT_ALLOWED',
    ],
    ['a hold over the order cap', { totalMinor: 250_000 }, 'PILOT_ORDER_LIMIT'],
    ['a reserved-seating hold', { seatBased: true }, 'PILOT_RESERVED_SEATING'],
  ])('refuses %s before any gateway order exists', async (_l, over, code) => {
    const { service, razorpayOrders } = payments(guard(PILOT).service, over);
    await expect(service.createIntent('b1')).rejects.toMatchObject({
      details: { reason: 'SALE_NOT_OPEN', blockers: expect.arrayContaining([code]) },
    });
    expect(razorpayOrders.createOrder).not.toHaveBeenCalled();
  });

  it('refuses a buyer not on the allowlist', async () => {
    const g = guard({ ...PILOT, PILOT_ALLOWED_BUYER_EMAILS: 'owner@example.test' }).service;
    const { service, razorpayOrders } = payments(g);
    await expect(service.createIntent('b1')).rejects.toMatchObject({
      details: { blockers: ['PILOT_BUYER_NOT_ALLOWED'] },
    });
    expect(razorpayOrders.createOrder).not.toHaveBeenCalled();
  });

  it('pilot off: a paused event is not the guard business, as before', async () => {
    const { service, razorpayOrders } = payments(guard(null).service, {
      event: {
        organizationId: 'org-other',
        isFree: false,
        venue: { country: 'IN' },
        status: 'PAUSED',
        experienceType: 'EVENT',
      },
    });
    await service.createIntent('b1');
    expect(razorpayOrders.createOrder).toHaveBeenCalledTimes(1);
  });
});
