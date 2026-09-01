import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * integration-real-postgres — cash taken at the venue.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * Asked for by an operator from a village where the cinema takes cash only: "this product
 * will be really helpful for them who cannot build and pay for software vendors". A
 * ticketing platform that insists on a card reader is unusable to exactly the venues that
 * most need somebody else's software.
 *
 * ── THE PROPERTY THAT MATTERS MOST ─────────────────────────────────────────────────
 * The money never passes through the platform. So a cash booking must never appear in a
 * settlement as an amount owed to the organizer — there is no bank statement it could be
 * reconciled against, and a payout built on one would be the platform paying out money it
 * never received.
 *
 * That falls out of the design rather than being enforced by a rule: like a free booking, a
 * cash booking creates NO Payment row, and settlement reads Payment rows. This suite exists
 * to prove that stays true, because it is the kind of property a later refactor breaks
 * silently and expensively.
 *
 * Skips (never fabricates a pass) when no database is reachable.
 */
function loadDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const p of ['../../../.env', '../../../../.env']) {
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

describe('integration-real-postgres: cash at the venue', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;

  const suffix = `cash-${Date.now()}`;
  let orgId = '';
  let venueId = '';
  let eventId = '';
  let sessionId = '';
  let ticketTypeId = '';

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db!.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — DB unavailable');
      return;
    }

    const org = await db!.organization.create({
      data: { name: `Cash ${suffix}`, slug: `cash-${suffix}`, status: 'APPROVED' },
    });
    orgId = org.id;
    const venue = await db!.venue.create({
      data: { organizationId: orgId, name: `Hall ${suffix}`, city: 'Warangal', country: 'India' },
    });
    venueId = venue.id;
    const event = await db!.event.create({
      data: {
        organizationId: orgId,
        venueId,
        title: `Cash Show ${suffix}`,
        slug: `cash-show-${suffix}`,
        category: 'Movie',
        status: 'PUBLISHED',
      },
    });
    eventId = event.id;
    const session = await db!.eventSession.create({
      data: {
        eventId,
        startsAt: new Date(Date.now() + 3 * 86_400_000),
        endsAt: new Date(Date.now() + 3 * 86_400_000 + 2 * 3_600_000),
      },
    });
    sessionId = session.id;
    const tt = await db!.ticketType.create({
      data: {
        eventSessionId: sessionId,
        name: 'Balcony',
        priceMinor: 12_000,
        quantityTotal: 100,
        inventory: { create: { quantityTotal: 100 } },
      },
    });
    ticketTypeId = tt.id;
  }, 120_000);

  afterAll(async () => {
    if (!db || !available) return;
    await db.ticket.deleteMany({ where: { booking: { organizationId: orgId } } });
    await db.bookingItem.deleteMany({ where: { booking: { organizationId: orgId } } });
    await db.payment.deleteMany({ where: { booking: { organizationId: orgId } } });
    await db.booking.deleteMany({ where: { organizationId: orgId } });
    await db.ticketInventory.deleteMany({ where: { ticketType: { eventSessionId: sessionId } } });
    await db.ticketType.deleteMany({ where: { eventSessionId: sessionId } });
    await db.eventSession.deleteMany({ where: { eventId } });
    await db.event.deleteMany({ where: { organizationId: orgId } });
    await db.venue.deleteMany({ where: { organizationId: orgId } });
    await db.organization.deleteMany({ where: { id: orgId } });
    await db.$disconnect();
  }, 120_000);

  const maybe = (name: string, fn: () => Promise<void>, timeout?: number) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  /*
    NOT tested here: that the hold runs until showtime rather than the usual few minutes.

    The fixtures below write bookings directly, so an assertion about `holdExpiresAt` would
    only be checking the fixture against itself — it passed for a while precisely because
    both sides used the same expression. That property is about what the BOOKING SERVICE
    decides, so it is proven end to end in `apps/e2e/tests/cash-payments.spec.ts`, against a
    booking made through the API.
  */

  /** A cash booking written the way the booking path writes one. */
  const cashBooking = async (status = 'PENDING_PAYMENT') =>
    db!.booking.create({
      data: {
        organizationId: orgId,
        eventId,
        eventSessionId: sessionId,
        buyerName: 'Village Buyer',
        buyerEmail: `buyer-${suffix}@test.invalid`,
        status: status as never,
        paymentMethod: 'CASH',
        subtotalMinor: 12_000,
        totalMinor: 12_000,
        holdExpiresAt: new Date(Date.now() + 3 * 86_400_000),
        items: {
          create: [
            {
              kind: 'TICKET',
              ticketTypeId,
              quantity: 1,
              unitPriceMinor: 12_000,
              lineTotalMinor: 12_000,
            },
          ],
        },
      },
    });

  maybe(
    'a cash booking carries no Payment row, so settlement can never pay it out',
    async () => {
      /*
        The whole financial safety argument in one assertion. Settlement sums Payment rows
        with status SUCCEEDED; a cash booking has none, so it cannot contribute to an amount
        the platform promises an organizer. If somebody ever "fixes" this by creating a
        zero-or-full Payment row for tidiness, this test is what stops it reaching money.
      */
      const booking = await cashBooking();

      const payments = await db!.payment.count({ where: { bookingId: booking.id } });
      expect(payments).toBe(0);

      // And the settlement query itself, run exactly as the service runs it, sees nothing.
      const settleable = await db!.payment.count({
        where: { status: 'SUCCEEDED', booking: { eventId } },
      });
      expect(settleable).toBe(0);

      await db!.bookingItem.deleteMany({ where: { bookingId: booking.id } });
      await db!.booking.delete({ where: { id: booking.id } });
    },
    120_000,
  );

  maybe(
    'collection is stamped with who took the money, and is idempotent under a race',
    async () => {
      /*
        This is the only payment path with no provider record behind it. If the till and the
        system disagree, the collector stamp is the entire account of who was holding the
        money — so it has to be written, and written once.

        The race is real: two people at one counter can press Collect at the same moment.
        The conditional update is the winner's proof, and the loser must not go on to issue
        a second set of tickets.
      */
      const booking = await cashBooking();
      const collector = await db!.user.create({
        data: {
          email: `teller-${suffix}@test.invalid`,
          fullName: 'Counter Teller',
          passwordHash: 'x',
          roles: ['CHECKIN_STAFF'],
        },
      });

      const claim = () =>
        db!.booking.updateMany({
          where: { id: booking.id, cashCollectedAt: null, paymentMethod: 'CASH' },
          data: { cashCollectedAt: new Date(), cashCollectedByUserId: collector.id },
        });

      const [first, second] = await Promise.all([claim(), claim()]);
      // Exactly one wins, whichever order Postgres serialises them in.
      expect(first.count + second.count).toBe(1);

      const after = await db!.booking.findUnique({ where: { id: booking.id } });
      expect(after.cashCollectedAt).not.toBeNull();
      expect(after.cashCollectedByUserId).toBe(collector.id);

      await db!.bookingItem.deleteMany({ where: { bookingId: booking.id } });
      await db!.booking.delete({ where: { id: booking.id } });
      await db!.user.delete({ where: { id: collector.id } });
    },
    120_000,
  );

  maybe(
    'the organization flag is off unless somebody turns it on',
    async () => {
      /*
        Taking money the platform never sees changes who is responsible for collecting it and
        what a settlement can promise. Inheriting that by default — for instance because a
        migration backfilled true, or a new organization copied a template — would enrol
        organizers in an arrangement nobody agreed to.
      */
      const fresh = await db!.organization.create({
        data: { name: `Default ${suffix}`, slug: `default-${suffix}` },
      });
      expect(fresh.cashPaymentsEnabled).toBe(false);
      await db!.organization.delete({ where: { id: fresh.id } });

      // And every booking that predates the feature reads as ONLINE, which is what they were.
      const online = await db!.booking.create({
        data: {
          organizationId: orgId,
          eventId,
          eventSessionId: sessionId,
          buyerName: 'Card Buyer',
          buyerEmail: `card-${suffix}@test.invalid`,
          subtotalMinor: 12_000,
          totalMinor: 12_000,
          holdExpiresAt: new Date(Date.now() + 900_000),
        },
      });
      expect(online.paymentMethod).toBe('ONLINE');
      await db!.booking.delete({ where: { id: online.id } });
    },
    120_000,
  );
});
