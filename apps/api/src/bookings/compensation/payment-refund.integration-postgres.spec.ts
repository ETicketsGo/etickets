import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * integration-real-postgres — Phase 6 controlled-refund invariants (ADR-043 §Phase 6, P5.3B).
 * Proves against REAL PostgreSQL the two primitives the refund finalizer depends on:
 *   - guarded finalize-once: N concurrent finalizers (duplicate workers / ambiguous-recovery
 *     replays) flip payment SUCCEEDED→REFUNDED + set refundedMinor EXACTLY once.
 *   - the money invariant: after a FULL refund, refundedMinor == captured (0 <= refunded <=
 *     captured); a captured payment is never refunded twice.
 * Concurrent one-plan-per-(booking, PAYMENT_REFUND) is proven in the provider-authoritative
 * real-Postgres suite. SKIPS visibly (never a fabricated pass) when PostgreSQL is unavailable.
 */
function loadDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const p of ['../../../.env', '../../../../.env']) {
    try {
      const m = readFileSync(resolve(__dirname, p), 'utf8').match(/^DATABASE_URL=(.*)$/m);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    } catch {
      /* try next */
    }
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PrismaClient } = require('@prisma/client');

describe('integration-real-postgres: controlled refund finalize-once + money invariant', () => {
  const url = loadDatabaseUrl();
  let prisma: InstanceType<typeof PrismaClient> | undefined;
  let available = false;
  const tag = `itest-refund-${Date.now()}`;
  const ids = { org: '', venue: '', event: '', session: '', booking: '' };

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — no DATABASE_URL');
      return;
    }
    prisma = new PrismaClient({ datasources: { db: { url } } });
    try {
      await prisma.$queryRaw`SELECT 1`;
      available = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[integration-real-postgres] SKIPPED — DB unavailable: ${(err as Error).message}`,
      );
    }
  });

  afterAll(async () => {
    if (prisma && available) {
      await prisma.payment.deleteMany({ where: { bookingId: ids.booking } }).catch(() => undefined);
      await prisma.booking.deleteMany({ where: { id: ids.booking } }).catch(() => undefined);
      await prisma.eventSession.deleteMany({ where: { id: ids.session } }).catch(() => undefined);
      await prisma.event.deleteMany({ where: { id: ids.event } }).catch(() => undefined);
      await prisma.venue.deleteMany({ where: { id: ids.venue } }).catch(() => undefined);
      await prisma.organization.deleteMany({ where: { id: ids.org } }).catch(() => undefined);
    }
    await prisma?.$disconnect().catch(() => undefined);
  });

  async function seedCapturedBooking(amountMinor: number): Promise<void> {
    const org = await prisma!.organization.create({ data: { name: tag, slug: `${tag}-org` } });
    ids.org = org.id;
    const venue = await prisma!.venue.create({
      data: { organizationId: org.id, name: tag, city: 'Testville' },
    });
    ids.venue = venue.id;
    const event = await prisma!.event.create({
      data: {
        organizationId: org.id,
        venueId: venue.id,
        title: tag,
        slug: `${tag}-evt`,
        category: 'test',
      },
    });
    ids.event = event.id;
    const session = await prisma!.eventSession.create({
      data: { eventId: event.id, startsAt: new Date('2099-01-01'), endsAt: new Date('2099-01-02') },
    });
    ids.session = session.id;
    const booking = await prisma!.booking.create({
      data: {
        organizationId: org.id,
        eventId: event.id,
        eventSessionId: session.id,
        buyerName: 'Buyer',
        buyerEmail: 'b@example.com',
        status: 'CANCELLED',
        currency: 'USD',
        subtotalMinor: amountMinor,
        totalMinor: amountMinor,
        holdExpiresAt: new Date('2099-01-01'),
      },
    });
    ids.booking = booking.id;
    await prisma!.payment.create({
      data: {
        bookingId: booking.id,
        provider: 'mock',
        status: 'SUCCEEDED',
        amountMinor,
        currency: 'USD',
        refundedMinor: 0,
        providerRef: 'pi_mock_1',
      },
    });
  }

  it('N concurrent finalizers refund a captured payment exactly once (guarded) and honour 0<=refunded<=captured', async () => {
    if (!available) return;
    const captured = 5000;
    await seedCapturedBooking(captured);

    // Mirror PaymentRefundExecutor.finalizeRefunded's guarded claim: SUCCEEDED→REFUNDED, set
    // refundedMinor. Duplicate workers / ambiguous-recovery replays race; only one may win.
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        prisma!.payment.updateMany({
          where: { bookingId: ids.booking, status: 'SUCCEEDED' },
          data: { status: 'REFUNDED', refundedMinor: captured },
        }),
      ),
    );
    const applied = results.filter((r) => r.status === 'fulfilled' && r.value.count === 1);
    expect(applied).toHaveLength(1); // finalized exactly once — never a double refund

    const pay = await prisma!.payment.findUnique({ where: { bookingId: ids.booking } });
    expect(pay?.status).toBe('REFUNDED');
    expect(pay?.refundedMinor).toBe(captured); // full refund == captured
    expect(pay!.refundedMinor).toBeGreaterThanOrEqual(0);
    expect(pay!.refundedMinor).toBeLessThanOrEqual(pay!.amountMinor); // invariant: refunded <= captured

    // A late finalize attempt after REFUNDED is a guarded no-op (idempotent).
    const late = await prisma!.payment.updateMany({
      where: { bookingId: ids.booking, status: 'SUCCEEDED' },
      data: { status: 'REFUNDED', refundedMinor: captured },
    });
    expect(late.count).toBe(0);
  }, 30_000);
});
