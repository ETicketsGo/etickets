import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PayoutsService } from './payouts.service';

/**
 * integration-real-postgres — raising payouts never pays the same revenue twice.
 *
 * The unit tests hold `generate` to its cursor and its scope rules against an in-memory ledger.
 * What they cannot prove is the lock: two requests arriving together each read "no open payout"
 * and each wrote one, and only a real database decides whether the advisory lock serialises
 * them. Several generates race here for one organization, and exactly one may win.
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

describe('integration-real-postgres: payout generation', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let payouts: PayoutsService;

  const suffix = `payout-${Date.now()}`;
  const owner = { id: 'payout-itest-owner', roles: [] } as never;
  let orgId = '';
  let eventId = '';
  let sessionId = '';

  /** A paid online booking, confirmed now — after any payout already raised. */
  async function sell(subtotalMinor: number) {
    await db!.booking.create({
      data: {
        organizationId: orgId,
        eventId,
        eventSessionId: sessionId,
        buyerName: 'Asha Rao',
        buyerEmail: `asha+${Math.random().toString(36).slice(2)}@example.test`,
        status: 'CONFIRMED',
        paymentMethod: 'ONLINE',
        currency: 'INR',
        feeMode: 'CUSTOMER_PAYS',
        subtotalMinor,
        bookingFeeMinor: 0,
        paymentFeeMinor: 0,
        discountMinor: 0,
        customerFeeMinor: 0,
        organizerFeeMinor: 0,
        taxMinor: 0,
        totalMinor: subtotalMinor,
        holdExpiresAt: new Date(Date.now() - 120_000),
        confirmedAt: new Date(),
      },
    });
  }

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — DB unavailable');
      return;
    }
    payouts = new PayoutsService(
      db as never,
      { assertMember: async () => undefined } as never,
      { record: async () => undefined } as never,
    );

    const org = await db.organization.create({
      data: { name: `Payout ${suffix}`, slug: `payout-${suffix}` },
    });
    orgId = org.id;
    const venue = await db.venue.create({
      data: { organizationId: orgId, name: `V ${suffix}`, city: 'Bengaluru', country: 'India' },
    });
    const event = await db.event.create({
      data: {
        organizationId: orgId,
        venueId: venue.id,
        title: `Payout night ${suffix}`,
        slug: `payout-night-${suffix}`,
        category: 'Music',
        status: 'PUBLISHED',
      },
    });
    eventId = event.id;
    const session = await db.eventSession.create({
      data: {
        eventId,
        startsAt: new Date(Date.now() + 86_400_000),
        endsAt: new Date(Date.now() + 90_000_000),
        status: 'SCHEDULED',
      },
    });
    sessionId = session.id;
  }, 60_000);

  afterAll(async () => {
    if (!db || !available) return;
    await db.payout.deleteMany({ where: { organizationId: orgId } });
    await db.booking.deleteMany({ where: { organizationId: orgId } });
    await db.eventSession.deleteMany({ where: { eventId } });
    await db.event.deleteMany({ where: { organizationId: orgId } });
    await db.venue.deleteMany({ where: { organizationId: orgId } });
    await db.organization.deleteMany({ where: { id: orgId } });
    await db.$disconnect();
  }, 60_000);

  const guard = () => {
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] test skipped — DB unavailable');
      return false;
    }
    return true;
  };

  it('creates exactly one payout when several generates race, in either scope', async () => {
    if (!guard()) return;
    await sell(10_000);

    // Org-wide and event-scoped requests together: they overlap, so they share the one lock.
    const attempts = await Promise.allSettled([
      payouts.generate(owner, orgId),
      payouts.generate(owner, orgId, eventId),
      payouts.generate(owner, orgId),
      payouts.generate(owner, orgId, eventId),
      payouts.generate(owner, orgId),
    ]);

    const won = attempts.filter((a) => a.status === 'fulfilled');
    const refused = attempts.filter((a) => a.status === 'rejected');
    expect(won).toHaveLength(1);
    for (const r of refused) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'CONFLICT' });
    }
    const rows = await db!.payout.findMany({ where: { organizationId: orgId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ currency: 'INR', grossMinor: 10_000, netMinor: 10_000 });
  });

  it('does not pay the event again once the org-wide payout is paid', async () => {
    if (!guard()) return;
    const [open] = await db!.payout.findMany({ where: { organizationId: orgId } });
    await payouts.markPaid(owner, open.id);

    await expect(payouts.generate(owner, orgId, eventId)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(payouts.generate(owner, orgId)).rejects.toMatchObject({ code: 'CONFLICT' });

    await sell(4_000);
    const [next] = await payouts.generate(owner, orgId, eventId);
    expect(next).toMatchObject({ eventId, grossMinor: 4_000 });
    expect(await db!.payout.count({ where: { organizationId: orgId } })).toBe(2);
  });
});
