import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PayoutsService } from './payouts.service';
import { eventMembership, mayRelease } from './payout-membership';
import * as allocation from './payout-allocation';

/**
 * integration-real-postgres — the consolidated allocation and ownership certification.
 *
 * Every figure is read back OUT of Postgres after the transaction closed. An assertion against
 * what a service returned proves only that the service agrees with itself.
 *
 * What this certifies, in order:
 *   1. the allocation sum equals the payout exactly
 *   2. a mismatch commits nothing at all
 *   3. an event payout names the right bookings and the right event
 *   4. a period payout exposes every event inside it
 *   5. a provider-owned event produces no platform claim, in every claimed status
 *   6. a partial reversal is still provider-owned
 *   7. a full reversal is still provider-owned, absent an explicit release
 *   8. a legacy payout reads as UNKNOWN, never as free
 *
 * ── ONE ORGANIZATION PER TEST ──────────────────────────────────────────────────────
 * The open-payout guard refuses a second payout while one is still PENDING in the same scope,
 * which is correct and makes a shared organization produce failures about the guard rather than
 * about the thing under test. Learned from the first run of the invariant suite, which reported
 * six failures that were all this.
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

/** One committed allocation row, as it is read back out of Postgres. */
interface AllocationRow {
  bookingId: string;
  eventId: string;
  currency: string;
  allocatedNetMinor: number;
  subtotalMinor: number;
  refundShareMinor: number;
}

/** The four statuses that mean a provider transfer owns an event's money. */
const PROVIDER_CLAIMED = [
  'TRANSFER_PROCESSING',
  'TRANSFERRED',
  'PARTIALLY_REFUNDED',
  'REVERSED',
] as const;

/** Statuses where the provider has NOT taken the money, so the platform still owns it. */
const PLATFORM_STILL_OWNS = ['PENDING', 'ELIGIBLE', 'APPROVED', 'FAILED'] as const;

describe('integration-real-postgres: payout allocation and ownership certification', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let payouts: PayoutsService;

  const suffix = `cert-${Date.now()}`;
  const owner = { id: 'cert-owner', roles: [] } as never;
  let orgId = '';
  const orgIds: string[] = [];
  const eventIds: string[] = [];

  async function freshOrg(label: string): Promise<void> {
    const org = await db!.organization.create({
      data: { name: `Cert ${label} ${suffix}`, slug: `cert-${label}-${suffix}` },
    });
    orgId = org.id;
    orgIds.push(org.id);
  }

  async function makeEvent(label: string) {
    const venue = await db!.venue.create({
      data: {
        organizationId: orgId,
        name: `V ${label} ${suffix}`,
        city: 'Bengaluru',
        country: 'India',
      },
    });
    const event = await db!.event.create({
      data: {
        organizationId: orgId,
        venueId: venue.id,
        title: `${label} ${suffix}`,
        slug: `cert-${label}-${suffix}-${Math.random().toString(36).slice(2, 8)}`,
        category: 'Music',
        status: 'COMPLETED',
      },
    });
    const session = await db!.eventSession.create({
      data: {
        eventId: event.id,
        startsAt: new Date(Date.now() - 90_000_000),
        endsAt: new Date(Date.now() - 86_400_000),
        status: 'COMPLETED',
      },
    });
    eventIds.push(event.id);
    return { eventId: event.id, sessionId: session.id };
  }

  async function sell(
    where: { eventId: string; sessionId: string },
    money: { currency?: string; subtotalMinor: number; organizerFeeMinor?: number },
  ): Promise<{ id: string }> {
    return db!.booking.create({
      data: {
        organizationId: orgId,
        eventId: where.eventId,
        eventSessionId: where.sessionId,
        buyerName: 'Asha Rao',
        buyerEmail: `cert+${Math.random().toString(36).slice(2)}@example.test`,
        status: 'CONFIRMED',
        paymentMethod: 'ONLINE',
        currency: money.currency ?? 'INR',
        feeMode: 'CUSTOMER_PAYS',
        subtotalMinor: money.subtotalMinor,
        discountMinor: 0,
        bookingFeeMinor: 0,
        paymentFeeMinor: 0,
        organizerFeeMinor: money.organizerFeeMinor ?? 0,
        customerFeeMinor: 0,
        taxMinor: 0,
        totalMinor: money.subtotalMinor,
        holdExpiresAt: new Date(Date.now() - 120_000),
        confirmedAt: new Date(),
      },
      select: { id: true },
    });
  }

  /** A provider settlement in a given status, which is how the provider path claims an event. */
  async function settleWithProvider(eventId: string, status: string, over: object = {}) {
    return db!.settlement.create({
      data: {
        organizationId: orgId,
        eventId,
        currency: 'inr',
        status: status as never,
        provider: 'razorpay',
        grossSalesMinor: 100_000,
        platformFeesMinor: 0,
        refundsMinor: 0,
        payableMinor: 100_000,
        transferredMinor: 100_000,
        releasedMinor: 100_000,
        providerTransferId: `trf_${Math.random().toString(36).slice(2, 10)}`,
        ...over,
      },
      select: { id: true },
    });
  }

  async function committed(payoutId: string) {
    const payout = await db!.payout.findUnique({
      where: { id: payoutId },
      select: { netMinor: true, currency: true, eventId: true, allocatedFrom: true },
    });
    const rows = (await db!.payoutAllocation.findMany({ where: { payoutId } })) as AllocationRow[];
    return {
      payout: payout!,
      rows,
      allocated: rows.reduce((t, r) => t + r.allocatedNetMinor, 0),
    };
  }

  const membershipOf = (eventId: string) =>
    eventMembership(db! as never, {
      organizationId: orgId,
      eventId,
      revenueFrom: new Date(Date.now() - 365 * 24 * 60 * 60_000),
      revenueTo: new Date(),
    });

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
      {
        effectiveFor: async () => ({
          holdDays: 0,
          minPayoutMinor: {},
          source: { holdDays: 'default', minPayoutMinor: 'default' },
        }),
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
    await db.refund.deleteMany({ where: { organizationId: { in: orgIds } } }).catch(() => {});
    await db.booking.deleteMany({ where: { organizationId: { in: orgIds } } }).catch(() => {});
    await db.eventSession.deleteMany({ where: { eventId: { in: eventIds } } }).catch(() => {});
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

  // ── 1 + 2 ────────────────────────────────────────────────────────────────────────
  describe('exact reconciliation', () => {
    it('commits a payout whose allocations account for it exactly', async () => {
      if (!guard()) return;
      await freshOrg('exact');
      const e = await makeEvent('exact');
      await sell(e, { subtotalMinor: 150_000, organizerFeeMinor: 7_500 });
      await sell(e, { subtotalMinor: 99_999, organizerFeeMinor: 4_999 });

      const [raised] = await payouts.generate(owner, orgId);
      const { payout, rows, allocated } = await committed(raised.id);

      expect(rows).toHaveLength(2);
      expect(`allocated=${allocated}`).toBe(`allocated=${payout.netMinor}`);
      // Not vacuously true against an all-zero payout.
      expect(payout.netMinor).toBeGreaterThan(0);
    });
  });

  describe('atomicity', () => {
    it('commits neither a payout nor an allocation when they disagree', async () => {
      if (!guard()) return;
      await freshOrg('atomic');
      const e = await makeEvent('atomic');
      await sell(e, { subtotalMinor: 77_000 });

      const before = {
        payouts: await db!.payout.count({ where: { organizationId: orgId } }),
        allocations: await db!.payoutAllocation.count({
          where: { payout: { organizationId: orgId } },
        }),
      };

      /*
        ── HOW THE MISMATCH IS INDUCED ─────────────────────────────────────────────────
        The gate is unreachable through the public API by construction: both derivations are
        handed the same rows, so they cannot disagree. Rather than adding an artificial path to
        make it fail "naturally" - which would mean shipping a way to produce unexplained
        financial evidence - the pure allocation function is spied on so the real service receives
        drifted drafts. Everything downstream is the production path.
      */
      /*
        The real function is captured BEFORE the spy replaces it. `jest.requireActual` returns the
        same already-spied module object here, so calling through it recursed until the stack gave
        out - a RangeError instead of the mismatch this test is about, which is how that was found.
      */
      const realAllocate = allocation.allocateCurrencySettlement;
      const spy = jest
        .spyOn(allocation, 'allocateCurrencySettlement')
        .mockImplementation((input) => {
          const drifted = realAllocate(input);
          for (const drafts of drifted.values()) {
            // One minor unit. The gate tolerates nothing, so nothing larger is needed.
            if (drafts.length > 0) drafts[0].allocatedNetMinor -= 1;
          }
          return drifted;
        });

      try {
        await expect(payouts.generate(owner, orgId)).rejects.toMatchObject({
          code: 'PAYOUT_ALLOCATION_MISMATCH',
        });
      } finally {
        spy.mockRestore();
      }

      const after = {
        payouts: await db!.payout.count({ where: { organizationId: orgId } }),
        allocations: await db!.payoutAllocation.count({
          where: { payout: { organizationId: orgId } },
        }),
      };
      // Read back from Postgres: the transaction rolled back, so neither count moved.
      expect(after).toEqual(before);

      // And with the drift gone the same data produces a payout, so the refusal was the gate
      // and not some unrelated breakage.
      const [recovered] = await payouts.generate(owner, orgId);
      const { allocated, payout } = await committed(recovered.id);
      expect(allocated).toBe(payout.netMinor);
    });
  });

  // ── 3 ────────────────────────────────────────────────────────────────────────────
  describe('an event payout', () => {
    it('names the right bookings, the right event, and the right total', async () => {
      if (!guard()) return;
      await freshOrg('event-scope');
      const mine = await makeEvent('mine');
      const other = await makeEvent('other');
      const a = await sell(mine, { subtotalMinor: 30_000 });
      const b = await sell(mine, { subtotalMinor: 20_000 });
      // Another event's revenue must not appear in an event-scoped payout.
      await sell(other, { subtotalMinor: 999_000 });

      const [raised] = await payouts.generate(owner, orgId, mine.eventId);
      const { payout, rows, allocated } = await committed(raised.id);

      expect(payout.eventId).toBe(mine.eventId);
      expect(rows.map((r) => r.bookingId).sort()).toEqual([a.id, b.id].sort());
      expect([...new Set(rows.map((r) => r.eventId))]).toEqual([mine.eventId]);
      expect(allocated).toBe(payout.netMinor);
      expect(payout.netMinor).toBe(50_000);
    });
  });

  // ── 4 ────────────────────────────────────────────────────────────────────────────
  describe('a period payout', () => {
    it('exposes every event inside it, which its own eventId cannot', async () => {
      if (!guard()) return;
      await freshOrg('period');
      const a = await makeEvent('p-a');
      const b = await makeEvent('p-b');
      const c = await makeEvent('p-c');
      await sell(a, { subtotalMinor: 10_000 });
      await sell(b, { subtotalMinor: 20_000 });
      await sell(c, { subtotalMinor: 30_000 });

      const [raised] = await payouts.generate(owner, orgId);
      const { payout, rows, allocated } = await committed(raised.id);

      expect(payout.eventId).toBeNull();
      expect(payout.allocatedFrom).not.toBeNull();
      expect(allocated).toBe(payout.netMinor);
      expect(payout.netMinor).toBe(60_000);

      // Membership is now a query, for every event in the period.
      expect([...new Set(rows.map((r) => r.eventId))].sort()).toEqual(
        [a.eventId, b.eventId, c.eventId].sort(),
      );
      for (const e of [a, b, c]) {
        const membership = await membershipOf(e.eventId);
        expect(membership.kind).toBe('CLAIMED_BY_PAYOUT');
        expect(mayRelease(membership)).toBe(false);
      }
    });
  });

  // ── 5, 6, 7 ──────────────────────────────────────────────────────────────────────
  describe('provider ownership excludes the platform ledger', () => {
    for (const status of PROVIDER_CLAIMED) {
      it(`produces no platform payout or allocation for a ${status} event`, async () => {
        if (!guard()) return;
        await freshOrg(`prov-${status.toLowerCase()}`);
        const claimedEvent = await makeEvent('claimed');
        const freeEvent = await makeEvent('free');
        await sell(claimedEvent, { subtotalMinor: 100_000 });
        await sell(freeEvent, { subtotalMinor: 40_000 });
        await settleWithProvider(claimedEvent.eventId, status);

        const raised = await payouts.generate(owner, orgId);

        // Only the unclaimed event settles, and the total says so.
        const allRows = await db!.payoutAllocation.findMany({
          where: { payout: { organizationId: orgId } },
          select: { eventId: true },
        });
        expect([...new Set(allRows.map((r: { eventId: string }) => r.eventId))]).toEqual([
          freeEvent.eventId,
        ]);
        expect(raised.reduce((t, p) => t + p.netMinor, 0)).toBe(40_000);

        // And the membership query attributes it to the provider, not to nobody.
        const membership = await membershipOf(claimedEvent.eventId);
        expect(membership.kind).toBe('CLAIMED_BY_PROVIDER');
        expect(mayRelease(membership)).toBe(false);
      });
    }

    it('still settles on the platform where the provider has NOT taken the money', async () => {
      if (!guard()) return;
      /*
        The other half of the boundary. If every settlement row excluded an event, approving a
        transfer would not be what moved ownership - merely creating a settlement would, and
        revenue would go unpaid while a settlement sat in PENDING.
      */
      for (const status of PLATFORM_STILL_OWNS) {
        await freshOrg(`unclaimed-${status.toLowerCase()}`);
        const e = await makeEvent('unclaimed');
        await sell(e, { subtotalMinor: 25_000 });
        await settleWithProvider(e.eventId, status);

        const raised = await payouts.generate(owner, orgId);
        expect(`${status} net=${raised.reduce((t, p) => t + p.netMinor, 0)}`).toBe(
          `${status} net=25000`,
        );
        const membership = await membershipOf(e.eventId);
        expect(`${status} ${membership.kind}`).toBe(`${status} CLAIMED_BY_PAYOUT`);
      }
    });

    it('keeps a PARTIALLY_REFUNDED event provider-owned, with no platform allocation', async () => {
      if (!guard()) return;
      await freshOrg('partial-reversal');
      const e = await makeEvent('partial');
      await sell(e, { subtotalMinor: 100_000 });
      // Some of the transfer came back, not all of it.
      await settleWithProvider(e.eventId, 'PARTIALLY_REFUNDED', { refundsMinor: 30_000 });

      await expect(payouts.generate(owner, orgId)).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(
        await db!.payoutAllocation.count({ where: { payout: { organizationId: orgId } } }),
      ).toBe(0);
      expect((await membershipOf(e.eventId)).kind).toBe('CLAIMED_BY_PROVIDER');
    });

    it('keeps a REVERSED event provider-owned absent an explicit release', async () => {
      if (!guard()) return;
      /*
        The defect this whole track began with. REVERSED means money went out and came back, and
        the status alone does not say why - an administrative correction leaves the organizer
        unpaid, a customer refund means the revenue no longer exists. Letting REVERSED fall back
        to the platform ledger would pay the organizer money that may have been returned to a
        customer. Nothing releases it but an explicit disposition, which does not exist yet.
      */
      await freshOrg('full-reversal');
      const e = await makeEvent('reversed');
      await sell(e, { subtotalMinor: 100_000 });
      await settleWithProvider(e.eventId, 'REVERSED', { refundsMinor: 100_000 });

      await expect(payouts.generate(owner, orgId)).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(
        await db!.payoutAllocation.count({ where: { payout: { organizationId: orgId } } }),
      ).toBe(0);
      const membership = await membershipOf(e.eventId);
      expect(membership.kind).toBe('CLAIMED_BY_PROVIDER');
      expect(mayRelease(membership)).toBe(false);
    });

    it('refuses to let both paths claim one event', async () => {
      if (!guard()) return;
      /*
        The collision attempt. A platform payout is raised first, THEN a provider transfer claims
        the same event. Both rows now exist, and the question is whether anything reads the event
        as owned twice. It does not: the provider answer wins, which is the same precedence the
        generator uses, so no caller can conclude the platform still owns it.
      */
      await freshOrg('collision');
      const e = await makeEvent('contested');
      await sell(e, { subtotalMinor: 50_000 });

      const [platformPayout] = await payouts.generate(owner, orgId, e.eventId);
      expect((await membershipOf(e.eventId)).kind).toBe('CLAIMED_BY_PAYOUT');

      await settleWithProvider(e.eventId, 'TRANSFERRED');
      const after = await membershipOf(e.eventId);
      // Exactly one owner is reported, and it is the authoritative one.
      expect(after.kind).toBe('CLAIMED_BY_PROVIDER');

      // The platform allocation still EXISTS - it is history, and deleting it would erase the
      // record of a payout that was really raised. Ownership is a read, not a mutation.
      expect(
        await db!.payoutAllocation.count({ where: { payoutId: platformPayout.id } }),
      ).toBeGreaterThan(0);
    });
  });

  // ── 8 ────────────────────────────────────────────────────────────────────────────
  describe('a legacy payout', () => {
    it('reads as UNKNOWN, never as free', async () => {
      if (!guard()) return;
      await freshOrg('legacy');
      const e = await makeEvent('legacy');
      // A payout from before allocations: no allocations, and allocatedFrom null.
      const legacy = await db!.payout.create({
        data: {
          organizationId: orgId,
          currency: 'INR',
          status: 'PAID',
          grossMinor: 90_000,
          netMinor: 90_000,
          periodStart: new Date(Date.now() - 30 * 24 * 60 * 60_000),
          periodEnd: new Date(),
        },
        select: { id: true, allocatedFrom: true },
      });
      expect(legacy.allocatedFrom).toBeNull();
      expect(await db!.payoutAllocation.count({ where: { payoutId: legacy.id } })).toBe(0);

      const membership = await membershipOf(e.eventId);
      /*
        THE RULE. Zero allocations exist for this event, and the honest answer is not NOT_CLAIMED:
        a payout that records nothing about its membership may well have covered it.
      */
      expect(membership.kind).toBe('UNKNOWN_LEGACY');
      expect(membership.kind).not.toBe('NOT_CLAIMED');
      expect(mayRelease(membership)).toBe(false);
      if (membership.kind === 'UNKNOWN_LEGACY') {
        expect(membership.payoutIds).toContain(legacy.id);
      }
    });

    it('reports NOT_CLAIMED only when every payout records what it covers', async () => {
      if (!guard()) return;
      /*
        The counterpart, so UNKNOWN_LEGACY is not simply what this function always says. An
        organization whose payouts are all allocation-backed CAN be proven free - that is the
        scope a release could safely act on.
      */
      await freshOrg('provably-free');
      const sold = await makeEvent('sold');
      const untouched = await makeEvent('untouched');
      await sell(sold, { subtotalMinor: 15_000 });

      await payouts.generate(owner, orgId, sold.eventId);

      const membership = await membershipOf(untouched.eventId);
      expect(membership.kind).toBe('NOT_CLAIMED');
      expect(mayRelease(membership)).toBe(true);
    });

    it('does not let one legacy payout make a provider-owned event look uncertain', async () => {
      if (!guard()) return;
      // Precedence again: a provider transfer is authoritative, so the legacy question is never
      // reached for that event.
      await freshOrg('legacy-vs-provider');
      const e = await makeEvent('both');
      await db!.payout.create({
        data: {
          organizationId: orgId,
          currency: 'INR',
          status: 'PAID',
          grossMinor: 1_000,
          netMinor: 1_000,
        },
      });
      await settleWithProvider(e.eventId, 'TRANSFERRED');
      expect((await membershipOf(e.eventId)).kind).toBe('CLAIMED_BY_PROVIDER');
    });
  });

  // ── the sweep ────────────────────────────────────────────────────────────────────
  it('holds the allocation invariant across every payout this suite created', async () => {
    if (!guard()) return;
    const all = await db!.payout.findMany({
      where: { organizationId: { in: orgIds }, allocatedFrom: { not: null } },
      select: { id: true, netMinor: true },
    });
    expect(all.length).toBeGreaterThan(0);

    const broken: string[] = [];
    for (const p of all) {
      const { allocated } = await committed(p.id);
      if (allocated !== p.netMinor)
        broken.push(`${p.id}: net=${p.netMinor} allocated=${allocated}`);
    }
    expect(broken).toEqual([]);
  });
});
