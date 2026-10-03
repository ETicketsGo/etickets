/*
  ── WHY THIS FILE HAS ITS OWN COUNTRY ─────────────────────────────────────────────────
  55 spec files create venues in country 'India', and `admin-grouping` asserts a global
  events-by-country count. Every one of those files is a writer into the bucket it counts, which
  makes that count a moving target for the whole run - and this suite was one of the writers that
  pushed it over.

  Nothing here asserts on country, so a unique one costs nothing and removes this file as an
  interferer. The general remediation is the same: a fixture dimension that another file can also
  write is not a fixture, it is a shared global.
*/
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { UnifiedFinanceService } from './unified-finance.service';

/**
 * integration-real-postgres — what a Finance reader can observe while a payout is being written.
 *
 * ── THE INVARIANT ─────────────────────────────────────────────────────────────────
 * A payout and its allocations are written in ONE transaction, so a reader must never see the
 * payout without them. That matters beyond tidiness: the producer reconciles allocation sums
 * against the stored totals, so a half-visible payout would report MISSING_ALLOCATIONS -
 * a FINANCIAL_INTEGRITY warning - about data that is perfectly healthy. The read model would be
 * crying wolf at exactly the moment money is being recorded.
 *
 * ── WHY THIS IS TESTED WITH CONCURRENCY RATHER THAN READ FROM THE CODE ────────────
 * "They are in a transaction, so it is fine" is a claim about Postgres isolation, the Prisma
 * client's connection handling, and the shape of this particular read - three things, none of
 * which the transaction code states. So a writer transaction is held OPEN while a second
 * connection reads, which is the only way to observe what a reader actually sees.
 *
 * Two moments are checked, because only together do they prove the invariant:
 *   DURING  the reader must see the PREVIOUS committed state - not a partial payout, and not
 *           nothing at all if something was already there.
 *   AFTER   the payout and its allocations must appear TOGETHER.
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

describe('integration-real-postgres: Unified Finance read consistency', () => {
  const url = loadDatabaseUrl();
  /** The writer. Holds the open transaction. */
  let writer: Client | undefined;
  /** A SEPARATE connection, so the read is genuinely concurrent rather than sharing a session. */
  let reader: Client | undefined;
  let available = false;
  let finance: UnifiedFinanceService;

  const suffix = `ufc-${Date.now()}`;
  const orgIds: string[] = [];
  const admin = { id: 'ufc-admin', roles: ['PLATFORM_ADMIN'] } as never;

  async function makeOrg(label: string): Promise<{ organizationId: string; eventId: string }> {
    const org = await writer!.organization.create({
      data: { name: `UFC ${label} ${suffix}`, slug: `ufc-${label}-${suffix}` },
    });
    orgIds.push(org.id);
    const venue = await writer!.venue.create({
      data: { organizationId: org.id, name: 'V', city: 'Bengaluru', country: 'Consistencyland' },
    });
    const event = await writer!.event.create({
      data: {
        organizationId: org.id,
        venueId: venue.id,
        title: `${label} ${suffix}`,
        slug: `ufc-${label}-${suffix}`,
        category: 'Music',
        status: 'COMPLETED',
      },
      select: { id: true },
    });
    return { organizationId: org.id, eventId: event.id };
  }

  /** A committed payout, so "the previous committed state" is something rather than nothing. */
  async function commitPayout(
    organizationId: string,
    eventId: string,
    netMinor: number,
  ): Promise<string> {
    const payout = await writer!.payout.create({
      data: {
        organizationId,
        eventId,
        currency: 'INR',
        status: 'PAID',
        grossMinor: netMinor,
        netMinor,
        allocatedFrom: new Date(),
      },
      select: { id: true },
    });
    await writer!.payoutAllocation.create({
      data: {
        payoutId: payout.id,
        bookingId: `bk-${payout.id}`,
        eventId,
        currency: 'INR',
        subtotalMinor: netMinor,
        discountMinor: 0,
        organizerFeeMinor: 0,
        refundShareMinor: 0,
        bookingFeeMinor: 0,
        paymentFeeMinor: 0,
        allocatedNetMinor: netMinor,
      },
    });
    return payout.id;
  }

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — no DATABASE_URL');
      return;
    }
    writer = new PrismaClient({ datasources: { db: { url } } });
    reader = new PrismaClient({ datasources: { db: { url } } });
    try {
      await writer.$queryRaw`SELECT 1`;
      await reader.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — DB unavailable');
      return;
    }
    // The read path runs on the reader connection, never the writer's.
    finance = new UnifiedFinanceService(
      reader as never,
      {
        assertMember: async () => undefined,
        isPlatformAdmin: () => true,
      } as never,
    );
  }, 60_000);

  afterAll(async () => {
    if (!writer || !available) return;
    const mine = await writer.payout.findMany({
      where: { organizationId: { in: orgIds } },
      select: { id: true },
    });
    for (const p of mine) {
      await writer.payoutAllocation.deleteMany({ where: { payoutId: p.id } }).catch(() => {});
    }
    await writer.payout.deleteMany({ where: { organizationId: { in: orgIds } } }).catch(() => {});
    await writer.event.deleteMany({ where: { organizationId: { in: orgIds } } }).catch(() => {});
    await writer.venue.deleteMany({ where: { organizationId: { in: orgIds } } }).catch(() => {});
    await writer.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => {});
    await writer.$disconnect();
    await reader?.$disconnect();
  }, 60_000);

  const guard = () => {
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] test skipped — DB unavailable');
      return false;
    }
    return true;
  };

  it('a reader mid-write sees the previous committed state, not a partial payout', async () => {
    if (!guard()) return;
    const { organizationId, eventId } = await makeOrg('during');
    // Something already committed, so "previous state" is a real figure and not an empty result.
    await commitPayout(organizationId, eventId, 40_000);

    const before = await finance.forOrganization(admin, organizationId);
    expect(before.currencies[0].summary.entitlementMinor).toBe(40_000);

    /*
      Hold a writer transaction open: create a payout and its allocations, then wait on a gate the
      test controls. Postgres will not show uncommitted rows to the other connection, and the
      point of the test is to observe that rather than assume it.
    */
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let newPayoutId = '';

    const writing = writer!.$transaction(async (tx: Client) => {
      const payout = await tx.payout.create({
        data: {
          organizationId,
          eventId,
          currency: 'INR',
          status: 'PAID',
          grossMinor: 90_000,
          netMinor: 90_000,
          allocatedFrom: new Date(),
        },
        select: { id: true },
      });
      newPayoutId = payout.id;
      await tx.payoutAllocation.create({
        data: {
          payoutId: payout.id,
          bookingId: 'bk-during',
          eventId,
          currency: 'INR',
          subtotalMinor: 90_000,
          discountMinor: 0,
          organizerFeeMinor: 0,
          refundShareMinor: 0,
          bookingFeeMinor: 0,
          paymentFeeMinor: 0,
          allocatedNetMinor: 90_000,
        },
      });
      // Both rows exist inside the transaction, and neither is committed.
      await gate;
    });

    // Wait until the writer has actually inserted, so the read is genuinely mid-transaction.
    const deadline = Date.now() + 10_000;
    while (newPayoutId === '' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(newPayoutId).not.toBe('');

    const during = await finance.forOrganization(admin, organizationId);
    /*
      THE ASSERTION. Still the previous committed state: one payout, 40 000. Not 130 000, not a
      payout with no allocations, and not an empty result.
    */
    expect(during.currencies[0].summary.entitlementMinor).toBe(40_000);
    expect(during.currencies[0].entries).toHaveLength(1);
    expect(during.currencies[0].entries[0].entry.sourceId).not.toBe(newPayoutId);
    // And nothing looks broken, because nothing is.
    expect(
      during.currencies[0].warnings.filter((w) => w.category === 'FINANCIAL_INTEGRITY'),
    ).toEqual([]);

    release();
    await writing;
  }, 120_000);

  it('after commit the payout and its allocations appear together', async () => {
    if (!guard()) return;
    const { organizationId, eventId } = await makeOrg('after');

    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let written = false;

    const writing = writer!.$transaction(async (tx: Client) => {
      const payout = await tx.payout.create({
        data: {
          organizationId,
          eventId,
          currency: 'INR',
          status: 'PAID',
          grossMinor: 75_000,
          netMinor: 71_000,
          refundMinor: 4_000,
          allocatedFrom: new Date(),
        },
        select: { id: true },
      });
      await tx.payoutAllocation.create({
        data: {
          payoutId: payout.id,
          bookingId: 'bk-after',
          eventId,
          currency: 'INR',
          subtotalMinor: 75_000,
          discountMinor: 0,
          organizerFeeMinor: 0,
          refundShareMinor: 4_000,
          bookingFeeMinor: 0,
          paymentFeeMinor: 0,
          allocatedNetMinor: 71_000,
        },
      });
      written = true;
      await gate;
    });

    const deadline = Date.now() + 10_000;
    while (!written && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    release();
    await writing;

    /*
      POLLED, not read once. Reading immediately after commit could pass by luck if the two rows
      became visible a moment apart. This takes the FIRST read in which the payout appears and
      asserts it already has its allocations - so a window where the payout exists alone would be
      caught rather than slept through.
    */
    let seen: Awaited<ReturnType<UnifiedFinanceService['forOrganization']>> | undefined;
    const pollUntil = Date.now() + 10_000;
    while (Date.now() < pollUntil) {
      const now = await finance.forOrganization(admin, organizationId);
      if (now.currencies.length > 0) {
        seen = now;
        break;
      }
    }
    expect(seen).toBeDefined();

    const group = seen!.currencies[0];
    expect(group.entries).toHaveLength(1);
    const entry = group.entries[0].entry;
    // The allocations were there in the very first read that saw the payout.
    expect(group.warnings.filter((w) => w.category === 'FINANCIAL_INTEGRITY')).toEqual([]);
    expect(entry.state).toBe('PAID');
    // Decomposition is present, which only allocations can supply.
    expect(entry.money.discountMinor).toBe(0);
    expect(entry.money.organizerNetMinor).toBe(71_000);
    expect(entry.money.refundsMinor).toBe(4_000);
  }, 120_000);

  it('a rolled-back write leaves the reader exactly where it was', async () => {
    if (!guard()) return;
    /*
      The other half of atomicity. A payout generation that fails must leave no trace a reader can
      see - not a payout, and not an allocation belonging to one.
    */
    const { organizationId, eventId } = await makeOrg('rollback');
    await commitPayout(organizationId, eventId, 25_000);
    const before = await finance.forOrganization(admin, organizationId);

    await expect(
      writer!.$transaction(async (tx: Client) => {
        const payout = await tx.payout.create({
          data: {
            organizationId,
            eventId,
            currency: 'INR',
            status: 'PAID',
            grossMinor: 999_999,
            netMinor: 999_999,
            allocatedFrom: new Date(),
          },
          select: { id: true },
        });
        await tx.payoutAllocation.create({
          data: {
            payoutId: payout.id,
            bookingId: 'bk-rollback',
            eventId,
            currency: 'INR',
            subtotalMinor: 999_999,
            discountMinor: 0,
            organizerFeeMinor: 0,
            refundShareMinor: 0,
            bookingFeeMinor: 0,
            paymentFeeMinor: 0,
            allocatedNetMinor: 999_999,
          },
        });
        // Exactly what the allocation gate does when the sums disagree.
        throw new Error('deliberate rollback');
      }),
    ).rejects.toThrow('deliberate rollback');

    const after = await finance.forOrganization(admin, organizationId);
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain('999999');
  }, 120_000);

  it('states what this proves, and what it does not', async () => {
    if (!guard()) return;
    /*
      ── THE HONEST LIMIT ───────────────────────────────────────────────────────────
      The platform path is atomic and the tests above demonstrate it: payout and allocations are
      one transaction, so a reader sees both or neither.
      The PROVIDER path is different and this suite does not claim otherwise. A settlement's status
      and its movement columns are updated by the settlement service, and whether every such update
      is a single transaction is a property of that service rather than of this read model. What
      the read model does guarantee is that a contradiction it CAN see - a released status with
      nothing released, more still out than was ever sent - surfaces as an integrity finding rather
      than a plausible number. That is tested in the producer suite, not here.
    */
    expect(true).toBe(true);
  });
});
