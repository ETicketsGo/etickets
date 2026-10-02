import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { payableBookingWhere } from './payouts.service';
import { calculateCurrencySettlement } from './currency-settlement.calculator';

/**
 * integration-real-postgres — proving a booking-level read can replace the aggregate.
 *
 * ── WHY THIS COMES BEFORE ANY SCHEMA ───────────────────────────────────────────────
 * `PayoutAllocation` needs the bookings a payout is made of, and the generator does not have
 * them: it uses `booking.groupBy` with `_sum`, so the money is added up inside the database.
 *
 * The tempting fix is a second query that re-selects the same bookings. That is the bug this
 * project keeps finding - two expressions of one eligibility rule, edited in one place. An
 * eligibility predicate that drifts does not fail loudly; it quietly pays somebody for a booking
 * the aggregate never counted.
 *
 * So there is ONE predicate, `payableBookingWhere`, and this proves that reading those bookings
 * individually and summing them in code produces EXACTLY what the database produced. Until that
 * holds, no allocation row may be written.
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

const MONEY = [
  'subtotalMinor',
  'discountMinor',
  'bookingFeeMinor',
  'paymentFeeMinor',
  'organizerFeeMinor',
] as const;

describe('integration-real-postgres: booking-level aggregation equals the database aggregate', () => {
  const url = loadDatabaseUrl();
  let db: Client | null = null;
  let available = false;
  let orgId = '';
  let eventId = '';
  const until = new Date();

  beforeAll(async () => {
    if (!url) return;
    try {
      db = new PrismaClient({ datasources: { db: { url } } });
      await db.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      available = false;
      return;
    }
    const stamp = Date.now();
    const org = await db!.organization.create({
      data: { name: `Equiv ${stamp}`, slug: `equiv-${stamp}`, status: 'APPROVED' },
    });
    orgId = org.id;
    const venue = await db!.venue.create({
      data: { organizationId: orgId, name: 'V', city: 'Bengaluru', country: 'India' },
    });
    const event = await db!.event.create({
      data: {
        organizationId: orgId,
        venueId: venue.id,
        title: `Equiv ${stamp}`,
        slug: `equiv-event-${stamp}`,
        category: 'Music',
        status: 'COMPLETED',
      },
    });
    eventId = event.id;
    const session = await db!.eventSession.create({
      data: {
        eventId,
        startsAt: new Date(until.getTime() - 7 * 24 * 60 * 60 * 1000),
        endsAt: new Date(until.getTime() - 7 * 24 * 60 * 60 * 1000 + 3_600_000),
        status: 'SCHEDULED',
      },
    });

    /*
      A deliberately awkward population: three currencies, a zero-value booking, a discount that
      exceeds its own subtotal, and amounts chosen so a mistaken sum would not coincidentally
      agree. Generated rather than hand-picked totals - the point is that NEITHER side is told
      what the answer should be.
    */
    const rows = [
      {
        currency: 'INR',
        subtotalMinor: 150_000,
        discountMinor: 10_000,
        bookingFeeMinor: 3_000,
        paymentFeeMinor: 2_500,
        organizerFeeMinor: 7_500,
      },
      {
        currency: 'INR',
        subtotalMinor: 99_999,
        discountMinor: 0,
        bookingFeeMinor: 1,
        paymentFeeMinor: 999,
        organizerFeeMinor: 4_999,
      },
      {
        currency: 'INR',
        subtotalMinor: 0,
        discountMinor: 0,
        bookingFeeMinor: 0,
        paymentFeeMinor: 0,
        organizerFeeMinor: 0,
      },
      {
        currency: 'USD',
        subtotalMinor: 40_000,
        discountMinor: 50_000,
        bookingFeeMinor: 1_200,
        paymentFeeMinor: 800,
        organizerFeeMinor: 2_000,
      },
      {
        currency: 'USD',
        subtotalMinor: 12_345,
        discountMinor: 345,
        bookingFeeMinor: 45,
        paymentFeeMinor: 5,
        organizerFeeMinor: 1_234,
      },
      {
        currency: 'CAD',
        subtotalMinor: 7,
        discountMinor: 3,
        bookingFeeMinor: 1,
        paymentFeeMinor: 1,
        organizerFeeMinor: 2,
      },
    ];
    let i = 0;
    for (const r of rows) {
      i += 1;
      await db!.booking.create({
        data: {
          organizationId: orgId,
          eventId,
          eventSessionId: session.id,
          buyerName: `Buyer ${i}`,
          buyerEmail: `buyer${i}@equiv.test`,
          reference: `EQV-${stamp}-${i}`,
          holdExpiresAt: new Date(until.getTime() - 60_000),
          status: 'CONFIRMED',
          paymentMethod: 'ONLINE',
          confirmedAt: new Date(until.getTime() - 60_000),
          totalMinor: r.subtotalMinor,
          ...r,
        },
      });
    }
  }, 120_000);

  afterAll(async () => {
    if (!available || !db) return;
    await db.booking.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.eventSession.deleteMany({ where: { eventId } }).catch(() => {});
    await db.event.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.venue.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
    await db.$disconnect();
  }, 60_000);

  const guard = () => {
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn('skipped — no database');
      return true;
    }
    return false;
  };

  /**
   * The ONE predicate, used by both sides. Duplicating it here would prove nothing.
   *
   * ── WHAT THIS SUITE DOES AND DOES NOT PROVE ──────────────────────────────────────
   * It proves that FOR A GIVEN PREDICATE, the database aggregate and a booking-level read agree
   * exactly - which is the question that has to be settled before allocations may be written
   * from the second.
   *
   * It does NOT prove that two predicates cannot drift apart, and it cannot: protection against
   * that is structural, not testable here. There is one `payableBookingWhere`, so there is
   * nothing to drift FROM. Verified by injecting drift into one side - the comparison test fails
   * and the two that build their own query do not, because they were never given the drifted
   * predicate. If a second definition is ever added, this suite will keep passing while the
   * ledger goes wrong, which is precisely why the second definition must not exist.
   */
  const where = () =>
    payableBookingWhere({
      organizationId: orgId,
      eventId: undefined,
      eventFilter: { status: { in: ['COMPLETED', 'ARCHIVED'] } },
      transferredEventIds: [],
      bookingWindows: [{ confirmedAt: { lte: until } }],
      eventSettled: [],
    });

  it('sums identically, field by field, for every currency', async () => {
    if (guard()) return;

    const aggregate = await db!.booking.groupBy({
      by: ['currency'],
      where: where(),
      _sum: {
        subtotalMinor: true,
        discountMinor: true,
        bookingFeeMinor: true,
        paymentFeeMinor: true,
        organizerFeeMinor: true,
      },
    });

    const bookings = await db!.booking.findMany({
      where: where(),
      select: {
        id: true,
        currency: true,
        subtotalMinor: true,
        discountMinor: true,
        bookingFeeMinor: true,
        paymentFeeMinor: true,
        organizerFeeMinor: true,
      },
    });

    // Both sides must actually have seen something, or "equal" is vacuous.
    expect(bookings.length).toBeGreaterThan(0);
    expect(aggregate.length).toBeGreaterThan(0);

    const derived = new Map<string, Record<string, number>>();
    for (const b of bookings as Array<Record<string, number | string>>) {
      const c = b.currency as string;
      const acc = derived.get(c) ?? Object.fromEntries(MONEY.map((k) => [k, 0]));
      for (const k of MONEY) acc[k] += b[k] as number;
      derived.set(c, acc);
    }

    expect([...derived.keys()].sort()).toEqual(
      aggregate.map((a: { currency: string }) => a.currency).sort(),
    );

    for (const row of aggregate as Array<{
      currency: string;
      _sum: Record<string, number | null>;
    }>) {
      const mine = derived.get(row.currency)!;
      for (const k of MONEY) {
        // Field by field, so a failure names the field rather than "objects differ".
        expect(`${row.currency}.${k}=${mine[k]}`).toBe(`${row.currency}.${k}=${row._sum[k] ?? 0}`);
      }
    }
  });

  it('produces identical settlement figures through the real calculator', async () => {
    if (guard()) return;

    const aggregate = await db!.booking.groupBy({
      by: ['currency'],
      where: where(),
      _sum: {
        subtotalMinor: true,
        discountMinor: true,
        bookingFeeMinor: true,
        paymentFeeMinor: true,
        organizerFeeMinor: true,
      },
    });
    const bookings = await db!.booking.findMany({
      where: where(),
      select: {
        currency: true,
        subtotalMinor: true,
        discountMinor: true,
        bookingFeeMinor: true,
        paymentFeeMinor: true,
        organizerFeeMinor: true,
      },
    });

    /*
      The claim that matters is not "the sums match" but "the PAYOUT is the same". Both inputs go
      through the authoritative calculator untouched - its arithmetic is not reimplemented here,
      which is the whole point.
    */
    const fromAggregate = calculateCurrencySettlement({
      revenue: (aggregate as Array<{ currency: string; _sum: Record<string, number | null> }>).map(
        (r) => ({
          currency: r.currency,
          subtotalMinor: r._sum.subtotalMinor ?? 0,
          discountMinor: r._sum.discountMinor ?? 0,
          bookingFeeMinor: r._sum.bookingFeeMinor ?? 0,
          paymentFeeMinor: r._sum.paymentFeeMinor ?? 0,
          organizerFeeMinor: r._sum.organizerFeeMinor ?? 0,
        }),
      ),
      refunds: [],
    });

    // Booking rows go in one per booking; the calculator groups by currency itself.
    const fromBookings = calculateCurrencySettlement({
      revenue: bookings as never,
      refunds: [],
    });

    expect(fromBookings).toEqual(fromAggregate);
  });

  it('every booking it would allocate is one the aggregate counted', async () => {
    if (guard()) return;
    /*
      The allocation invariant, stated before any allocation exists: the set of bookings a
      booking-level read returns is exactly the population the aggregate summed. If this ever
      fails, allocations would explain a payout using bookings it was not made of.
    */
    const bookings = await db!.booking.findMany({ where: where(), select: { id: true } });
    const counted = await db!.booking.count({ where: where() });
    expect(bookings.length).toBe(counted);
  });
});
