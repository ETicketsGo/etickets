import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * integration-real-postgres — the allocation ledger's CONSTRAINTS, and nothing else.
 *
 * Schema and persistence only. Nothing writes allocations in production yet; the generator change
 * is its own PR. What is being checked here is that the table can hold the evidence a payout
 * explanation actually needs, and that its constraints refuse the things that would corrupt it.
 *
 * The distinction this file exists for: an ABSENT allocation set and an EMPTY one are different
 * facts. A payout raised before allocations existed has unknown membership; a payout raised under
 * the allocation regime with no allocations would be a bug. Reading the first as the second is
 * exactly what would let a release claim revenue a legacy payout already covers.
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

describe('integration-real-postgres: the payout allocation ledger', () => {
  const url = loadDatabaseUrl();
  let db: Client | null = null;
  let available = false;
  let orgId = '';

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
      data: { name: `Alloc ${stamp}`, slug: `alloc-${stamp}`, status: 'APPROVED' },
    });
    orgId = org.id;
  }, 60_000);

  afterAll(async () => {
    if (!available || !db) return;
    const payouts = await db.payout.findMany({
      where: { organizationId: orgId },
      select: { id: true },
    });
    for (const p of payouts) {
      await db.payoutAllocation.deleteMany({ where: { payoutId: p.id } }).catch(() => {});
    }
    await db.payout.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
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

  /** A payout raised under the allocation regime. */
  const allocatedPayout = (netMinor: number, currency = 'INR') =>
    db!.payout.create({
      data: {
        organizationId: orgId,
        currency,
        status: 'PENDING',
        grossMinor: netMinor,
        netMinor,
        allocatedFrom: new Date(),
      },
    });

  const allocation = (payoutId: string, bookingId: string, over: Record<string, unknown> = {}) =>
    db!.payoutAllocation.create({
      data: {
        payoutId,
        bookingId,
        eventId: 'e1',
        currency: 'INR',
        allocatedNetMinor: 10_000,
        subtotalMinor: 12_000,
        discountMinor: 1_000,
        organizerFeeMinor: 1_000,
        refundShareMinor: 0,
        bookingFeeMinor: 300,
        paymentFeeMinor: 200,
        ...over,
      },
    });

  describe('one booking cannot be counted twice in one payout', () => {
    it('refuses a second allocation for the same booking', async () => {
      if (guard()) return;
      const p = await allocatedPayout(10_000);
      await allocation(p.id, 'bk_1');
      // A booking contributing twice is a double count, refused by the database rather than
      // trusted to the writer.
      await expect(allocation(p.id, 'bk_1')).rejects.toThrow();
    });

    it('allows the same booking in a DIFFERENT payout', async () => {
      if (guard()) return;
      /*
        Legitimate: a later corrective payout may carry a negative allocation for a booking an
        earlier payout already included. Forbidding it outright would make corrections
        impossible.
      */
      const a = await allocatedPayout(10_000);
      const b = await allocatedPayout(-2_000);
      await allocation(a.id, 'bk_shared');
      const second = await allocation(b.id, 'bk_shared', { allocatedNetMinor: -2_000 });
      expect(second.allocatedNetMinor).toBe(-2_000);
    });
  });

  describe('the snapshot explains the amount', () => {
    it('stores components that reconstruct the net without re-reading the booking', async () => {
      if (guard()) return;
      const p = await allocatedPayout(10_000);
      const a = await allocation(p.id, 'bk_snap', {
        subtotalMinor: 15_000,
        discountMinor: 2_000,
        organizerFeeMinor: 1_500,
        refundShareMinor: 500,
        allocatedNetMinor: 11_000,
      });

      // net = subtotal − discount − organizerFee − refundShare
      expect(a.subtotalMinor - a.discountMinor - a.organizerFeeMinor - a.refundShareMinor).toBe(
        a.allocatedNetMinor,
      );
    });

    it('keeps booking and payment fees OUT of the net equation', async () => {
      if (guard()) return;
      /*
        They are reported, not deducted: `subtotalMinor` is already the ticket value net to the
        organizer and those two are borne by the customer on top. Stored so an allocation can
        explain the payout's own reported fee columns, never so they can be subtracted.
      */
      const p = await allocatedPayout(10_000);
      const a = await allocation(p.id, 'bk_fees', {
        subtotalMinor: 12_000,
        discountMinor: 1_000,
        organizerFeeMinor: 1_000,
        refundShareMinor: 0,
        bookingFeeMinor: 5_000,
        paymentFeeMinor: 4_000,
        allocatedNetMinor: 10_000,
      });
      expect(a.allocatedNetMinor).toBe(10_000);
      expect(a.subtotalMinor - a.discountMinor - a.organizerFeeMinor - a.refundShareMinor).toBe(
        10_000,
      );
    });

    it('accepts a negative allocation, because a refund can exceed its own revenue', async () => {
      if (guard()) return;
      const p = await allocatedPayout(-5_000);
      const a = await allocation(p.id, 'bk_neg', {
        subtotalMinor: 1_000,
        discountMinor: 0,
        organizerFeeMinor: 0,
        refundShareMinor: 6_000,
        allocatedNetMinor: -5_000,
      });
      expect(a.allocatedNetMinor).toBe(-5_000);
    });
  });

  describe('period payout membership becomes queryable', () => {
    it('answers which events a payout with no eventId covers', async () => {
      if (guard()) return;
      /*
        The whole point. `Payout.eventId` is null for a period payout, so before allocations the
        events it covered were unknowable. Now they are a query.
      */
      const p = await allocatedPayout(30_000);
      expect(p.eventId).toBeNull();
      await allocation(p.id, 'bk_a', { eventId: 'ev_1', allocatedNetMinor: 10_000 });
      await allocation(p.id, 'bk_b', { eventId: 'ev_2', allocatedNetMinor: 10_000 });
      await allocation(p.id, 'bk_c', { eventId: 'ev_1', allocatedNetMinor: 10_000 });

      const rows = await db!.payoutAllocation.findMany({
        where: { payoutId: p.id },
        select: { eventId: true },
      });
      expect([...new Set(rows.map((r: { eventId: string }) => r.eventId))].sort()).toEqual([
        'ev_1',
        'ev_2',
      ]);
    });

    it('answers which payouts claim a given booking', async () => {
      if (guard()) return;
      const p = await allocatedPayout(10_000);
      await allocation(p.id, 'bk_lookup');
      const claims = await db!.payoutAllocation.findMany({ where: { bookingId: 'bk_lookup' } });
      expect(claims.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('legacy payouts are absent, not empty', () => {
    it('marks a payout raised before allocations as unknown membership', async () => {
      if (guard()) return;
      const legacy = await db!.payout.create({
        data: {
          organizationId: orgId,
          currency: 'INR',
          status: 'PAID',
          grossMinor: 50_000,
          netMinor: 45_000,
          // No allocatedFrom: it predates the regime.
        },
      });
      expect(legacy.allocatedFrom).toBeNull();

      const rows = await db!.payoutAllocation.findMany({ where: { payoutId: legacy.id } });
      expect(rows).toEqual([]);

      /*
        Both a legacy payout and a hypothetical broken new one would show zero allocations. Only
        `allocatedFrom` tells them apart, which is why reading "no allocations" as "covers
        nothing" would be the dangerous mistake - a legacy payout may well cover the event
        somebody is about to release.
      */
      const covered = await allocatedPayout(10_000);
      expect(covered.allocatedFrom).not.toBeNull();
    });
  });

  describe('deleting a payout does not orphan its evidence', () => {
    it('cascades allocations away with the payout', async () => {
      if (guard()) return;
      const p = await allocatedPayout(10_000);
      await allocation(p.id, 'bk_cascade');
      await db!.payout.delete({ where: { id: p.id } });
      expect(await db!.payoutAllocation.findMany({ where: { payoutId: p.id } })).toEqual([]);
    });
  });
});
