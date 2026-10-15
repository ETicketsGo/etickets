import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BookingsService } from '../bookings/bookings.service';
import { PricingStrategiesService } from '../pricing/pricing-strategies.service';
import {
  FlatPricingStrategy,
  SeatPricingStrategy,
  TierPricingStrategy,
} from '../pricing/pricing-strategies';
import { GeneralAdmissionInventoryStrategy } from '../inventory/general-admission.strategy';
import { SALE_NOT_OPEN_REASON } from '../pricing/cinema-policy/sale-eligibility';
import { PilotGuardService } from './pilot-guard.service';

/**
 * integration-real-postgres - the pilot's daily cap holds for buyers arriving at once.
 *
 * ── WHY REAL POSTGRES ──────────────────────────────────────────────────────────────
 * The cap is "count today's sales, then add this one". Two buyers doing that at the same moment
 * each see room for themselves and together pass it, unless the count and the insert are
 * serialized. That is a property of Postgres transactions and `pg_advisory_xact_lock`, which a
 * stub cannot have. The booking is the real `BookingsService.create` with the real
 * general-admission hold; only pricing is stubbed (total = subtotal).
 *
 * ── THE FIXTURE ────────────────────────────────────────────────────────────────────
 * Its own organization, venue, event and ticket type, all deleted afterwards. The cap counts
 * only the pilot organizations, so other engineers' rows in a shared database cannot move it.
 * Skips (never fabricates a pass) when no database is reachable.
 */
function loadDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const p of ['../../../../.env', '../../../../../.env']) {
    try {
      const txt = readFileSync(resolve(__dirname, p), 'utf8');
      const m = txt.match(/^DATABASE_URL=(.*)$/m);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    } catch {
      /* try next */
    }
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PrismaClient } = require('@prisma/client');
type Client = InstanceType<typeof PrismaClient>;

const suffix = `pilot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
/** Rs 1,000 a ticket; a daily cap of Rs 1,500 leaves room for exactly one one-ticket order. */
const PRICE = 100_000;
const DAILY_CAP = 150_000;

type Outcome = 'SOLD' | { blockers: unknown } | string;

describe('integration-real-postgres: the pilot daily cap under concurrency', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let bookings: BookingsService;
  let pilot: PilotGuardService;
  let orgId = '';
  let venueId = '';
  let eventId = '';
  let sessionId = '';
  let ticketTypeId = '';

  const cart = (n: number) =>
    ({
      eventSessionId: sessionId,
      buyerName: 'Pilot buyer',
      buyerEmail: `buyer${n}@pilot.test`,
      items: [{ ticketTypeId, quantity: 1 }],
    }) as never;

  async function attempt(p: Promise<unknown>): Promise<Outcome> {
    try {
      await p;
      return 'SOLD';
    } catch (e) {
      const err = e as { message?: string; details?: { reason?: string; blockers?: unknown } };
      if (err.details?.reason === SALE_NOT_OPEN_REASON) return { blockers: err.details.blockers };
      return String(err.message);
    }
  }

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - DB unavailable');
      return;
    }

    const org = await db.organization.create({
      data: { name: `Pilot ${suffix}`, slug: `pilot-${suffix}`, status: 'APPROVED' },
    });
    orgId = org.id;
    const venue = await db.venue.create({
      data: {
        organizationId: orgId,
        name: `Pilot hall ${suffix}`,
        city: 'Bengaluru',
        region: 'Karnataka',
        country: 'India',
        timezone: 'Asia/Kolkata',
      },
    });
    venueId = venue.id;
    const event = await db.event.create({
      data: {
        organizationId: orgId,
        venueId,
        title: `Pilot show ${suffix}`,
        slug: `pilot-show-${suffix}`,
        category: 'Music',
        status: 'PUBLISHED',
        publishedAt: new Date(),
      },
    });
    eventId = event.id;
    const start = Date.now() + 30 * 86_400_000;
    const session = await db.eventSession.create({
      data: { eventId, startsAt: new Date(start), endsAt: new Date(start + 3 * 3_600_000) },
    });
    sessionId = session.id;
    const tt = await db.ticketType.create({
      data: {
        eventSessionId: sessionId,
        name: 'General',
        priceMinor: PRICE,
        currency: 'INR',
        quantityTotal: 100,
      },
    });
    ticketTypeId = tt.id;
    await db.ticketInventory.create({ data: { ticketTypeId, quantityTotal: 100 } });

    const env: Record<string, string> = {
      PILOT_MODE: 'on',
      PILOT_ALLOWED_ORGANIZATION_IDS: orgId,
      PILOT_MAX_ORDER_MINOR: '200000',
      PILOT_MAX_DAILY_SALES_MINOR: String(DAILY_CAP),
      // The test runs with no Razorpay key, so INR goes to the configured (mock) provider.
      PILOT_ALLOWED_PROVIDERS: 'razorpay,mock',
      PAYMENT_PROVIDER_NAME: 'mock',
    };
    pilot = new PilotGuardService(db as never, { get: (k: string) => env[k] } as never);

    const audit = { record: async () => undefined } as never;
    const noop = { observe: async () => undefined } as never;
    bookings = new BookingsService(
      db as never,
      {
        quote: async (subtotal: number, _m: string, discount: number, currency: string) => ({
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
        }),
      } as never,
      new PricingStrategiesService(
        new FlatPricingStrategy(),
        new TierPricingStrategy(),
        new SeatPricingStrategy(),
      ),
      audit,
      {
        forSeating: () => new GeneralAdmissionInventoryStrategy(),
        forExperienceType: () => new GeneralAdmissionInventoryStrategy(),
      } as never,
      { reserve: async () => undefined, release: async () => undefined } as never,
      { recordBookingCreated: () => undefined } as never,
      noop,
      noop,
      undefined,
      undefined,
      undefined,
      undefined,
      pilot,
    );
  }, 120_000);

  afterAll(async () => {
    if (!db || !available) return;
    await db.booking.deleteMany({ where: { organizationId: orgId } });
    await db.ticketInventory.deleteMany({ where: { ticketTypeId } });
    await db.ticketType.deleteMany({ where: { eventSessionId: sessionId } });
    await db.eventSession.deleteMany({ where: { eventId } });
    await db.event.deleteMany({ where: { organizationId: orgId } });
    await db.venue.deleteMany({ where: { organizationId: orgId } });
    await db.organization.deleteMany({ where: { id: orgId } });
    await db.$disconnect();
  }, 120_000);

  const maybe = (name: string, fn: () => Promise<void>) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      60_000,
    );

  maybe('buyers arriving at once who together pass the cap: exactly one is sold', async () => {
    /*
      The window between "count" and "commit" is a few milliseconds, so on a fast machine the
      buyers can line up by luck and the race never happens. The count is made to linger for
      100 ms, which every concurrent create then overlaps: without the pilot lock all eight
      are sold (seen), with it the other seven wait at the lock and count the first one.
    */
    const realCount = pilot.countedToday.bind(pilot);
    const slowCount = jest
      .spyOn(pilot, 'countedToday')
      .mockImplementation(async (...args: Parameters<PilotGuardService['countedToday']>) => {
        const n = await realCount(...args);
        await new Promise((r) => setTimeout(r, 100));
        return n;
      });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => attempt(bookings.create(null, cart(i + 1)))),
    );
    slowCount.mockRestore();
    expect(results.filter((r) => r === 'SOLD')).toHaveLength(1);
    expect(results.filter((r) => r !== 'SOLD')).toEqual(
      Array.from({ length: 7 }, () => ({ blockers: ['PILOT_DAILY_LIMIT'] })),
    );
    // And the database agrees: one hold, Rs 1,000 counted.
    expect(await db!.booking.count({ where: { organizationId: orgId } })).toBe(1);
    expect(await pilot.countedToday(db as never, 'INR')).toBe(PRICE);
  });

  maybe('a quote now agrees with the create: the next order is over the cap', async () => {
    expect(await attempt(bookings.quote(cart(10)))).toEqual({ blockers: ['PILOT_DAILY_LIMIT'] });
    expect(await attempt(bookings.create(null, cart(10)))).toEqual({
      blockers: ['PILOT_DAILY_LIMIT'],
    });
  });

  maybe('an expired hold frees its room, before the sweep has marked it EXPIRED', async () => {
    await db!.booking.updateMany({
      where: { organizationId: orgId, status: 'PENDING_PAYMENT' },
      data: { holdExpiresAt: new Date(Date.now() - 1000) },
    });
    expect(await pilot.countedToday(db as never, 'INR')).toBe(0);
    expect(await attempt(bookings.quote(cart(11)))).toBe('SOLD');
    expect(await attempt(bookings.create(null, cart(11)))).toBe('SOLD');
  });

  maybe('a confirmed booking keeps counting', async () => {
    await db!.booking.updateMany({
      where: {
        organizationId: orgId,
        status: 'PENDING_PAYMENT',
        holdExpiresAt: { gt: new Date() },
      },
      data: { status: 'CONFIRMED' },
    });
    expect(await pilot.countedToday(db as never, 'INR')).toBe(PRICE);
    expect(await attempt(bookings.create(null, cart(12)))).toEqual({
      blockers: ['PILOT_DAILY_LIMIT'],
    });
  });
});
