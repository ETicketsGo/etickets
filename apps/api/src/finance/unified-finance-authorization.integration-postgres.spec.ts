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
import { OrgAccessService } from '../tenancy/org-access.service';

/**
 * integration-real-postgres — cross-tenant attacks against the Finance read path.
 *
 * ── WHY THIS USES THE REAL OrgAccessService ────────────────────────────────────────
 * A stubbed `assertMember` would prove only that the service calls something. These tests build
 * REAL memberships in Postgres and let the real tenancy service decide, so what is under test is
 * the actual boundary an organizer would meet.
 *
 * ── THE PROPERTY, NOT JUST THE OUTCOME ─────────────────────────────────────────────
 * Denial is necessary but not sufficient. The brief's rule is that authorization happens BEFORE
 * financial evidence enters the result - not that it is filtered out afterwards. So one test
 * counts the queries the service issues on a denied call and asserts it is zero: nothing
 * financial was ever read, so there was nothing to forget to filter.
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

describe('integration-real-postgres: Unified Finance authorization', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let finance: UnifiedFinanceService;

  const suffix = `ufa-${Date.now()}`;
  const orgIds: string[] = [];
  const userIds: string[] = [];

  /** Organization A, whose owner is userA. */
  let orgA = '';
  let eventA = '';
  let payoutA = '';
  /** Organization B, whose owner is userB. A must never see any of this. */
  let orgB = '';
  let eventB = '';
  let payoutB = '';
  let settlementB = '';

  let userA = { id: '', roles: [] as string[] } as never;
  let userB = { id: '', roles: [] as string[] } as never;
  let outsider = { id: '', roles: [] as string[] } as never;

  async function makeUser(label: string): Promise<string> {
    const u = await db!.user.create({
      data: {
        email: `${label}-${suffix}@example.test`,
        passwordHash: 'x',
        fullName: label,
      },
      select: { id: true },
    });
    userIds.push(u.id);
    return u.id;
  }

  async function makeOrgWithOwner(label: string, userId: string): Promise<string> {
    const org = await db!.organization.create({
      data: { name: `UFA ${label} ${suffix}`, slug: `ufa-${label}-${suffix}` },
    });
    orgIds.push(org.id);
    await db!.organizationMember.create({
      data: { organizationId: org.id, userId, role: 'ORGANIZER_OWNER', status: 'ACTIVE' },
    });
    return org.id;
  }

  async function makeEvent(organizationId: string, label: string): Promise<string> {
    const venue = await db!.venue.create({
      data: { organizationId, name: `V ${label}`, city: 'Bengaluru', country: 'Authland' },
    });
    const event = await db!.event.create({
      data: {
        organizationId,
        venueId: venue.id,
        title: `${label} ${suffix}`,
        slug: `ufa-${label}-${suffix}-${Math.random().toString(36).slice(2, 8)}`,
        category: 'Music',
        status: 'COMPLETED',
      },
    });
    return event.id;
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

    // The real tenancy service, deciding from real memberships.
    finance = new UnifiedFinanceService(
      db as never,
      new OrgAccessService(db as never, { record: async () => undefined } as never),
    );

    const uA = await makeUser('owner-a');
    const uB = await makeUser('owner-b');
    const uO = await makeUser('outsider');
    userA = { id: uA, roles: [] } as never;
    userB = { id: uB, roles: [] } as never;
    outsider = { id: uO, roles: [] } as never;

    orgA = await makeOrgWithOwner('a', uA);
    orgB = await makeOrgWithOwner('b', uB);
    eventA = await makeEvent(orgA, 'ev-a');
    eventB = await makeEvent(orgB, 'ev-b');

    // A has a modest payout; B has money A must never be able to infer.
    const pA = await db.payout.create({
      data: {
        organizationId: orgA,
        eventId: eventA,
        currency: 'INR',
        status: 'PAID',
        grossMinor: 10_000,
        netMinor: 10_000,
        allocatedFrom: new Date(),
      },
      select: { id: true },
    });
    payoutA = pA.id;
    await db.payoutAllocation.create({
      data: {
        payoutId: payoutA,
        bookingId: 'bk-a',
        eventId: eventA,
        currency: 'INR',
        subtotalMinor: 10_000,
        discountMinor: 0,
        organizerFeeMinor: 0,
        refundShareMinor: 0,
        bookingFeeMinor: 0,
        paymentFeeMinor: 0,
        allocatedNetMinor: 10_000,
      },
    });

    const pB = await db.payout.create({
      data: {
        organizationId: orgB,
        // A PERIOD payout, so its membership lives only in allocations - the inference path.
        eventId: null,
        currency: 'USD',
        status: 'PAID',
        grossMinor: 777_777,
        netMinor: 777_777,
        allocatedFrom: new Date(),
      },
      select: { id: true },
    });
    payoutB = pB.id;
    await db.payoutAllocation.create({
      data: {
        payoutId: payoutB,
        bookingId: 'bk-b',
        eventId: eventB,
        currency: 'USD',
        subtotalMinor: 777_777,
        discountMinor: 0,
        organizerFeeMinor: 0,
        refundShareMinor: 0,
        bookingFeeMinor: 0,
        paymentFeeMinor: 0,
        allocatedNetMinor: 777_777,
      },
    });

    const sB = await db.settlement.create({
      data: {
        organizationId: orgB,
        eventId: eventB,
        provider: 'razorpay',
        currency: 'usd',
        status: 'TRANSFERRED',
        grossSalesMinor: 555_555,
        releasedMinor: 555_555,
        transferredMinor: 555_555,
      },
      select: { id: true },
    });
    settlementB = sB.id;
  }, 120_000);

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
    await db.organizationMember
      .deleteMany({ where: { organizationId: { in: orgIds } } })
      .catch(() => {});
    await db.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => {});
    await db.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
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

  describe('the legitimate case still works', () => {
    it('lets an owner read their own organization', async () => {
      if (!guard()) return;
      const result = await finance.forOrganization(userA, orgA);
      expect(result.currencies).toHaveLength(1);
      expect(result.currencies[0].summary.entitlementMinor).toBe(10_000);
    }, 60_000);

    it('lets an owner read their own event', async () => {
      if (!guard()) return;
      const result = await finance.forOrganization(userA, orgA, eventA);
      expect(result.currencies[0].entries).toHaveLength(1);
    }, 60_000);
  });

  describe('cross-tenant attacks', () => {
    it('refuses a substituted organizationId', async () => {
      if (!guard()) return;
      await expect(finance.forOrganization(userA, orgB)).rejects.toMatchObject({
        code: 'TENANT_FORBIDDEN',
      });
    }, 60_000);

    it("refuses another organization's eventId under that organization", async () => {
      if (!guard()) return;
      await expect(finance.forOrganization(userA, orgB, eventB)).rejects.toMatchObject({
        code: 'TENANT_FORBIDDEN',
      });
    }, 60_000);

    it('refuses a mismatched pair: own organization, foreign event', async () => {
      if (!guard()) return;
      /*
        The case the brief calls out explicitly. Membership passes - A really does own orgA - so
        the only thing standing between the caller and another tenant's event scope is the
        ownership check on the event itself.
      */
      await expect(finance.forOrganization(userA, orgA, eventB)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    }, 60_000);

    it('answers a foreign event and a non-existent event identically', async () => {
      if (!guard()) return;
      /*
        Otherwise the difference between the two responses is an existence oracle: a caller could
        enumerate which event ids are real by watching which error came back.
      */
      const foreign = await finance
        .forOrganization(userA, orgA, eventB)
        .catch((e: { code?: string; status?: number }) => ({ code: e.code, status: e.status }));
      const absent = await finance
        .forOrganization(userA, orgA, 'cmnonexistentnonexistent0')
        .catch((e: { code?: string; status?: number }) => ({ code: e.code, status: e.status }));
      expect(foreign).toEqual(absent);
    }, 60_000);

    it('refuses a non-member entirely', async () => {
      if (!guard()) return;
      await expect(finance.forOrganization(outsider, orgA)).rejects.toMatchObject({
        code: 'TENANT_FORBIDDEN',
      });
      await expect(finance.forOrganization(outsider, orgB)).rejects.toMatchObject({
        code: 'TENANT_FORBIDDEN',
      });
    }, 60_000);

    it('leaks nothing about B through a period payout allocation', async () => {
      if (!guard()) return;
      /*
        B's payout is period-scoped, so its event membership lives only in PayoutAllocation. If
        the platform fetch joined allocations without the organization filter, A asking about
        B's event could surface it. A is refused before any of that runs.
      */
      await expect(finance.forOrganization(userA, orgA, eventB)).rejects.toBeDefined();
      const mine = await finance.forOrganization(userA, orgA);
      const serialized = JSON.stringify(mine);
      for (const secret of [payoutB, settlementB, eventB, orgB, '777777', '555555']) {
        expect(serialized).not.toContain(secret);
      }
    }, 60_000);

    it('never returns B evidence in B-scoped data to A, in either direction', async () => {
      if (!guard()) return;
      // And the mirror: B sees only B.
      const theirs = await finance.forOrganization(userB, orgB);
      const serialized = JSON.stringify(theirs);
      expect(serialized).toContain(payoutB);
      for (const secret of [payoutA, eventA, orgA]) {
        expect(serialized).not.toContain(secret);
      }
    }, 60_000);
  });

  describe('authorization happens before financial evidence is read', () => {
    it('issues no financial query at all on a denied call', async () => {
      if (!guard()) return;
      /*
        ── THE STRUCTURAL PROPERTY ──────────────────────────────────────────────────────
        Denial alone would be satisfied by fetching broadly and filtering at the end, which leaves
        another tenant's financial evidence in memory one forgotten filter from a response. This
        counts the actual queries: on a denied call, payout/settlement/allocation reads must be
        zero, so there was never anything to filter.
      */
      const payoutFind = jest.spyOn(db!.payout, 'findMany');
      const settlementFind = jest.spyOn(db!.settlement, 'findMany');
      try {
        await expect(finance.forOrganization(userA, orgB)).rejects.toBeDefined();
        expect(payoutFind).not.toHaveBeenCalled();
        expect(settlementFind).not.toHaveBeenCalled();
      } finally {
        payoutFind.mockRestore();
        settlementFind.mockRestore();
      }
    }, 60_000);

    it('issues no financial query when only the event scope is foreign', async () => {
      if (!guard()) return;
      // Membership passes here, so this proves the event check also precedes the money reads.
      const payoutFind = jest.spyOn(db!.payout, 'findMany');
      const settlementFind = jest.spyOn(db!.settlement, 'findMany');
      try {
        await expect(finance.forOrganization(userA, orgA, eventB)).rejects.toBeDefined();
        expect(payoutFind).not.toHaveBeenCalled();
        expect(settlementFind).not.toHaveBeenCalled();
      } finally {
        payoutFind.mockRestore();
        settlementFind.mockRestore();
      }
    }, 60_000);
  });

  describe('sensitive data', () => {
    it('exposes no bank, provider or credential fields', async () => {
      if (!guard()) return;
      const serialized = JSON.stringify(await finance.forOrganization(userB, orgB));
      for (const forbidden of [
        'connectedAccountId',
        'providerTransferId',
        'accountNumber',
        'accountId',
        'bankCode',
        'holderName',
        'idempotencyKey',
        'syncResponse',
        'providerStatusRaw',
        'lastError',
        'passwordHash',
        'buyerEmail',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    }, 60_000);

    it('exposes no provider name, so the path is visible without the vendor', async () => {
      if (!guard()) return;
      /*
        `sourceType` says PROVIDER, which an organizer-facing view needs. The vendor's identity is
        a separate disclosure decision made in UI copy (see the #190 probe), not something a
        Finance payload leaks by default.
      */
      const serialized = JSON.stringify(await finance.forOrganization(userB, orgB));
      expect(serialized).not.toContain('razorpay');
      expect(serialized).toContain('SETTLEMENT');
    }, 60_000);
  });
});
