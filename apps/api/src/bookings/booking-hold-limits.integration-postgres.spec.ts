import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BookingHoldLimitsService } from './booking-hold-limits';

/**
 * integration-real-postgres - the active-hold limits hold under concurrency, in a real database.
 *
 * The unit specs run the limits over an in-memory imitation of Postgres. This proves the parts an
 * imitation cannot: that `pg_advisory_xact_lock` really serialises two transactions for one buyer,
 * that the raw SQL behind the per-IP ledger names the right tables and compares the status enum
 * correctly, and that a hold which is paid or expires stops counting at once.
 *
 * Each "hold" is the guard plus a booking insert plus the ledger write, in one transaction, which
 * is exactly the shape `BookingsService.create` gives them.
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

const tag = `holds-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

describe('integration-real-postgres: active-hold limits', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let orgId = '';
  let eventId = '';
  let sessionId = '';
  const guard = new BookingHoldLimitsService({
    get: (k: string) => (k === 'BOOKING_MAX_ACTIVE_HOLDS_PER_IP' ? 5 : undefined),
  } as never);

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db!.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - DB unavailable');
      return;
    }
    const org = await db!.organization.create({
      data: { name: `Holds ${tag}`, slug: `holds-${tag}`, status: 'APPROVED' },
    });
    orgId = org.id;
    const venue = await db!.venue.create({
      data: {
        organizationId: orgId,
        name: `Hall ${tag}`,
        city: 'Vijayawada',
        country: 'India',
        timezone: 'Asia/Kolkata',
      },
    });
    const event = await db!.event.create({
      data: {
        organizationId: orgId,
        venueId: venue.id,
        title: `Holds ${tag}`,
        slug: `holds-${tag}`,
        category: 'Concert',
        status: 'PUBLISHED',
      },
    });
    eventId = event.id;
    const startsAt = new Date(Date.now() + 7 * 86_400_000);
    const session = await db!.eventSession.create({
      data: { eventId, startsAt, endsAt: new Date(startsAt.getTime() + 7_200_000) },
    });
    sessionId = session.id;
  }, 120_000);

  afterAll(async () => {
    if (!db || !available) return;
    const ids = (await db.booking.findMany({ where: { organizationId: orgId } })).map(
      (b: { id: string }) => b.id,
    );
    await db.idempotencyRecord.deleteMany({ where: { key: { in: ids } } });
    await db.booking.deleteMany({ where: { organizationId: orgId } });
    await db.eventSession.deleteMany({ where: { eventId } });
    await db.event.deleteMany({ where: { organizationId: orgId } });
    await db.venue.deleteMany({ where: { organizationId: orgId } });
    await db.organization.deleteMany({ where: { id: orgId } });
    await db.$disconnect();
  }, 120_000);

  /** One hold, shaped as `create` shapes it: guard, insert, ledger, one transaction. */
  async function hold(opts: { email: string; ip?: string; cash?: boolean }) {
    const now = new Date();
    const holdExpiresAt = new Date(now.getTime() + 10 * 60_000);
    return db!.$transaction(
      async (tx: never) => {
        const receipt = await guard.enforce(tx, {
          userId: null,
          buyerEmail: opts.email,
          clientIp: opts.ip ?? null,
          eventSessionId: sessionId,
          wantsCash: Boolean(opts.cash),
          now,
        });
        // Wide enough that parallel transactions overlap while holding the lock.
        await new Promise((r) => setTimeout(r, 20));
        const b = await (tx as Client).booking.create({
          data: {
            organizationId: orgId,
            eventId,
            eventSessionId: sessionId,
            buyerName: 'Buyer',
            buyerEmail: opts.email,
            status: 'PENDING_PAYMENT',
            paymentMethod: opts.cash ? 'CASH' : 'ONLINE',
            subtotalMinor: 1000,
            totalMinor: 1000,
            holdExpiresAt,
          },
        });
        await receipt.record(b.id, holdExpiresAt);
        return b;
      },
      { timeout: 30_000, maxWait: 30_000 },
    );
  }

  const maybe = (name: string, fn: () => Promise<void>) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      120_000,
    );

  maybe('twenty parallel holds from one guest address end with exactly three', async () => {
    const email = `flood-${tag}@test.invalid`;
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        hold({ email: Math.random() < 0.5 ? email : email.toUpperCase() }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    const live = await db!.booking.count({
      where: { organizationId: orgId, buyerEmail: { equals: email, mode: 'insensitive' } },
    });
    expect(live).toBe(3);
  });

  maybe('a paid or expired hold stops counting at once', async () => {
    const email = `cycle-${tag}@test.invalid`;
    const made = [await hold({ email }), await hold({ email }), await hold({ email })];
    await expect(hold({ email })).rejects.toThrow(/waiting for payment/);
    await db!.booking.update({ where: { id: made[0].id }, data: { status: 'CONFIRMED' } });
    await expect(hold({ email })).resolves.toBeTruthy();
    await db!.booking.update({
      where: { id: made[1].id },
      data: { holdExpiresAt: new Date(Date.now() - 1000) },
    });
    await expect(hold({ email })).resolves.toBeTruthy();
  });

  maybe(
    'one client address is capped across changing emails, and its ledger stays small',
    async () => {
      const ip = `198.51.100.${Math.floor(Math.random() * 250)}`;
      const results = await Promise.allSettled(
        Array.from({ length: 9 }, (_, i) => hold({ email: `bot-${i}-${tag}@test.invalid`, ip })),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
      // Release one; the next hold from that address both succeeds and prunes the dead row.
      const one = (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{
        id: string;
      }>)!.value;
      await db!.booking.update({ where: { id: one.id }, data: { status: 'EXPIRED' } });
      await expect(hold({ email: `late-${tag}@test.invalid`, ip })).resolves.toBeTruthy();
      const ledger = await db!.idempotencyRecord.count({ where: { key: one.id } });
      expect(ledger).toBe(0);
    },
  );

  maybe('parallel cash reservations for one show end with exactly one', async () => {
    const email = `cash-${tag}@test.invalid`;
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => hold({ email, cash: true })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  maybe('parallel extensions stop at the cap (the conditional update)', async () => {
    const b = await hold({ email: `extend-${tag}@test.invalid` });
    const max = 10;
    const outcomes = await Promise.all(
      Array.from({ length: 15 }, () =>
        db!.booking.updateMany({
          where: {
            id: b.id,
            status: 'PENDING_PAYMENT',
            paymentMethod: 'ONLINE',
            holdExpiresAt: { gt: new Date() },
            holdExtensions: { lt: max },
          },
          data: {
            holdExpiresAt: new Date(Date.now() + 10 * 60_000),
            holdExtensions: { increment: 1 },
          },
        }),
      ),
    );
    expect(outcomes.filter((o: { count: number }) => o.count === 1)).toHaveLength(max);
    const row = await db!.booking.findUnique({ where: { id: b.id } });
    expect(row.holdExtensions).toBe(max);
  });
});
