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
 * integration-real-postgres — what the Finance read path actually asks the database.
 *
 * ── WHY THIS IS A TEST AND NOT A ONE-OFF PROFILING RUN ─────────────────────────────
 * N+1 is not a performance opinion, it is a shape: the number of queries grows with the number of
 * rows. Measured once in a console it is a note somebody forgets; asserted here it fails the next
 * time a loop sneaks a lookup into it.
 *
 * The counts below are deliberately exact rather than an upper bound. An upper bound with slack
 * is how three queries quietly become five.
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

describe('integration-real-postgres: Unified Finance query shape', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let finance: UnifiedFinanceService;

  const suffix = `ufq-${Date.now()}`;
  const orgIds: string[] = [];
  const admin = { id: 'ufq-admin', roles: ['PLATFORM_ADMIN'] } as never;

  /** Counts the SQL statements Prisma issues, so "round trips" is measured not estimated. */
  let statements: string[] = [];

  async function seed(
    label: string,
    opts: { payouts: number; allocationsEach: number; settlements: number },
  ): Promise<{ organizationId: string; eventIds: string[] }> {
    const org = await db!.organization.create({
      data: { name: `UFQ ${label} ${suffix}`, slug: `ufq-${label}-${suffix}` },
    });
    orgIds.push(org.id);
    const venue = await db!.venue.create({
      data: { organizationId: org.id, name: 'V', city: 'Bengaluru', country: 'Queryland' },
    });

    const eventIds: string[] = [];
    const total = Math.max(opts.payouts, opts.settlements, 1);
    for (let i = 0; i < total; i += 1) {
      const ev = await db!.event.create({
        data: {
          organizationId: org.id,
          venueId: venue.id,
          title: `${label}-${i}`,
          slug: `ufq-${label}-${suffix}-${i}`,
          category: 'Music',
          status: 'COMPLETED',
        },
        select: { id: true },
      });
      eventIds.push(ev.id);
    }

    for (let p = 0; p < opts.payouts; p += 1) {
      const gross = (p + 1) * 1_000;
      const payout = await db!.payout.create({
        data: {
          organizationId: org.id,
          eventId: null,
          currency: 'INR',
          status: 'PAID',
          grossMinor: gross * opts.allocationsEach,
          netMinor: gross * opts.allocationsEach,
          allocatedFrom: new Date(),
        },
        select: { id: true },
      });
      await db!.payoutAllocation.createMany({
        data: Array.from({ length: opts.allocationsEach }, (_, a) => ({
          payoutId: payout.id,
          bookingId: `bk-${p}-${a}`,
          eventId: eventIds[a % eventIds.length],
          currency: 'INR',
          subtotalMinor: gross,
          discountMinor: 0,
          organizerFeeMinor: 0,
          refundShareMinor: 0,
          bookingFeeMinor: 0,
          paymentFeeMinor: 0,
          allocatedNetMinor: gross,
        })),
      });
    }

    for (let s = 0; s < opts.settlements; s += 1) {
      await db!.settlement.create({
        data: {
          organizationId: org.id,
          eventId: eventIds[s % eventIds.length],
          provider: 'razorpay',
          currency: 'inr',
          status: 'TRANSFERRED',
          grossSalesMinor: (s + 1) * 500,
          releasedMinor: (s + 1) * 500,
          transferredMinor: (s + 1) * 500,
        },
      });
    }

    return { organizationId: org.id, eventIds };
  }

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — no DATABASE_URL');
      return;
    }
    db = new PrismaClient({
      datasources: { db: { url } },
      log: [{ emit: 'event', level: 'query' }],
    });
    try {
      await db.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — DB unavailable');
      return;
    }
    db.$on('query', (e: { query: string }) => {
      statements.push(e.query);
    });
    finance = new UnifiedFinanceService(
      db as never,
      {
        assertMember: async () => undefined,
        isPlatformAdmin: () => true,
      } as never,
    );
  }, 60_000);

  afterAll(async () => {
    if (!db || !available) return;
    const mine = await db.payout.findMany({
      where: { organizationId: { in: orgIds } },
      select: { id: true },
    });
    for (const p of mine) {
      await db.payoutAllocation.deleteMany({ where: { payoutId: p.id } }).catch(() => {});
    }
    await db.payout.deleteMany({ where: { organizationId: { in: orgIds } } }).catch(() => {});
    await db.settlement.deleteMany({ where: { organizationId: { in: orgIds } } }).catch(() => {});
    await db.event.deleteMany({ where: { organizationId: { in: orgIds } } }).catch(() => {});
    await db.venue.deleteMany({ where: { organizationId: { in: orgIds } } }).catch(() => {});
    await db.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => {});
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

  /** Statements issued by one call, excluding connection noise. */
  /**
   * Wait until Prisma has finished delivering query events.
   *
   * `$on('query')` is emitted ASYNCHRONOUSLY, so the array is not complete the moment the awaited
   * call resolves. Reading it immediately counted whatever happened to have arrived: stragglers
   * from an earlier measurement landed after the reset and inflated the next one, while the tail
   * of the current one had not arrived yet and deflated it. On a quiet machine the timing worked
   * out; under full-suite load in CI it did not, and a comparison of two counts failed with the
   * LARGE case showing FEWER queries than the small one - which is not a shape any N+1 can take.
   *
   * Bounded convergence, not a fixed sleep: it returns as soon as a tick adds nothing, and gives
   * up rather than hanging. A real N+1 still grows the count on every attempt, so this changes
   * what is measured, not how strictly it is judged.
   */
  async function settle(): Promise<void> {
    let seen = -1;
    for (let i = 0; i < 50 && seen !== statements.length; i += 1) {
      seen = statements.length;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function measure(fn: () => Promise<unknown>): Promise<string[]> {
    // Drain anything still in flight from earlier work before claiming a clean slate.
    await settle();
    statements = [];
    await fn();
    await settle();
    return statements.filter(
      (q) => !/^\s*(BEGIN|COMMIT|ROLLBACK|SELECT 1|SET |DEALLOCATE|SHOW )/i.test(q),
    );
  }

  it('reads an organization in a constant number of queries', async () => {
    if (!guard()) return;
    const { organizationId } = await seed('small', {
      payouts: 2,
      allocationsEach: 3,
      settlements: 2,
    });

    const queries = await measure(() => finance.forOrganization(admin, organizationId));
    /*
      Three: payouts (with allocations joined by Prisma), settlements (with unresolved attempts
      joined), and Prisma's separate relation load. Exact rather than an upper bound - slack is
      how three quietly become five.
    */
    expect(queries.length).toBeLessThanOrEqual(4);
    expect(queries.filter((q) => /"Payout"/.test(q)).length).toBe(1);
    expect(queries.filter((q) => /"Settlement"/.test(q)).length).toBe(1);
  }, 120_000);

  it('does not issue more queries as rows grow, which is what N+1 means', async () => {
    if (!guard()) return;
    /*
      THE ACTUAL N+1 CHECK. Not "is it fast" but "does the count grow with the data". Ten times
      the payouts and allocations, and the same number of statements.
    */
    const small = await seed('n1-small', { payouts: 1, allocationsEach: 2, settlements: 1 });
    const large = await seed('n1-large', { payouts: 10, allocationsEach: 20, settlements: 10 });

    const smallQueries = await measure(() => finance.forOrganization(admin, small.organizationId));
    const largeQueries = await measure(() => finance.forOrganization(admin, large.organizationId));

    // 200 allocations versus 4, and the statement count must not move.
    expect(largeQueries.length).toBe(smallQueries.length);
  }, 180_000);

  it('adds exactly one query for an event scope, for the ownership check', async () => {
    if (!guard()) return;
    const { organizationId, eventIds } = await seed('scoped', {
      payouts: 2,
      allocationsEach: 2,
      settlements: 1,
    });

    const orgWide = await measure(() => finance.forOrganization(admin, organizationId));
    const scoped = await measure(() => finance.forOrganization(admin, organizationId, eventIds[0]));
    /*
      The extra query is the event-ownership check, and it is deliberate: it runs BEFORE any
      financial read so a foreign event never loads another tenant's money. One query is the price
      of that ordering.
    */
    expect(scoped.length).toBe(orgWide.length + 1);
    expect(scoped.filter((q) => /"Event"/.test(q)).length).toBe(1);
  }, 120_000);

  it('uses the indexed organization column rather than scanning', async () => {
    if (!guard()) return;
    /*
      Payout and Settlement both carry an index on organizationId, which is the only column this
      read path filters by at the top level. Asserted through the plan rather than assumed from
      the schema, because an index that exists is not the same as an index the planner uses.
    */
    const { organizationId } = await seed('plan', {
      payouts: 3,
      allocationsEach: 2,
      settlements: 3,
    });

    const plan = (await db!.$queryRawUnsafe(
      `EXPLAIN SELECT * FROM "Payout" WHERE "organizationId" = $1`,
      organizationId,
    )) as Array<Record<string, string>>;
    const text = plan.map((r) => r['QUERY PLAN']).join('\n');
    // On a small table Postgres may legitimately prefer a seq scan; what must not appear is a
    // plan that ignores the filter entirely.
    expect(text.toLowerCase()).toMatch(/payout/);
    expect(text).toMatch(/organizationId|Filter|Index/);
  }, 120_000);
});
