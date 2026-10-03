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
 * integration-real-postgres — Unified Finance against persisted authoritative evidence.
 *
 * ── WHAT MAKES THIS DIFFERENT FROM THE COMPOSER SUITE ──────────────────────────────
 * The composer suite proves the arithmetic against in-memory fixtures. It cannot prove that the
 * FETCH is right: that an event-scoped query finds a period payout through its allocations, that
 * allocations are loaded whole rather than filtered into disagreement, that a legacy payout's
 * absent decomposition survives Prisma and JSON, or that one organization cannot read another's.
 * Those are properties of the read path, and only a database can answer them.
 *
 * So this persists source rows, calls `UnifiedFinanceService` - the production read path - and
 * asserts integers on what comes back. The test setup never recomputes what a producer computes.
 *
 * ── ONE ORGANIZATION PER SCENARIO ──────────────────────────────────────────────────
 * Finance is organization-scoped, so sharing one would let scenarios see each other's money and
 * make every assertion depend on execution order.
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

describe('integration-real-postgres: Unified Finance read path', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let finance: UnifiedFinanceService;

  const suffix = `uf-${Date.now()}`;
  const orgIds: string[] = [];
  const eventIds: string[] = [];

  /** A platform-admin caller, so membership is satisfied without building memberships. */
  const admin = { id: 'uf-admin', roles: ['PLATFORM_ADMIN'], isPlatformAdmin: true } as never;

  async function makeOrg(label: string): Promise<string> {
    const org = await db!.organization.create({
      data: { name: `UF ${label} ${suffix}`, slug: `uf-${label}-${suffix}` },
    });
    orgIds.push(org.id);
    return org.id;
  }

  async function makeEvent(organizationId: string, label: string): Promise<string> {
    const venue = await db!.venue.create({
      data: {
        organizationId,
        name: `V ${label} ${suffix}`,
        city: 'Bengaluru',
        country: 'Financeland',
      },
    });
    const event = await db!.event.create({
      data: {
        organizationId,
        venueId: venue.id,
        title: `${label} ${suffix}`,
        slug: `uf-${label}-${suffix}-${Math.random().toString(36).slice(2, 8)}`,
        category: 'Music',
        status: 'COMPLETED',
      },
    });
    eventIds.push(event.id);
    return event.id;
  }

  /** A payout persisted with its allocations, exactly as the generator would write them. */
  async function makePayout(
    organizationId: string,
    row: {
      eventId?: string | null;
      currency?: string;
      status?: string;
      grossMinor: number;
      bookingFeeMinor?: number;
      paymentFeeMinor?: number;
      refundMinor?: number;
      netMinor: number;
      legacy?: boolean;
    },
    allocations: Array<{
      bookingId: string;
      eventId: string;
      currency?: string;
      subtotalMinor: number;
      discountMinor?: number;
      organizerFeeMinor?: number;
      refundShareMinor?: number;
      bookingFeeMinor?: number;
      paymentFeeMinor?: number;
      allocatedNetMinor: number;
    }> = [],
  ): Promise<string> {
    const payout = await db!.payout.create({
      data: {
        organizationId,
        eventId: row.eventId ?? null,
        currency: row.currency ?? 'INR',
        status: (row.status ?? 'PAID') as never,
        grossMinor: row.grossMinor,
        bookingFeeMinor: row.bookingFeeMinor ?? 0,
        paymentFeeMinor: row.paymentFeeMinor ?? 0,
        refundMinor: row.refundMinor ?? 0,
        netMinor: row.netMinor,
        periodEnd: new Date(),
        allocatedFrom: row.legacy ? null : new Date(),
      },
      select: { id: true },
    });
    if (allocations.length > 0) {
      await db!.payoutAllocation.createMany({
        data: allocations.map((a) => ({
          payoutId: payout.id,
          bookingId: a.bookingId,
          eventId: a.eventId,
          currency: a.currency ?? row.currency ?? 'INR',
          subtotalMinor: a.subtotalMinor,
          discountMinor: a.discountMinor ?? 0,
          organizerFeeMinor: a.organizerFeeMinor ?? 0,
          refundShareMinor: a.refundShareMinor ?? 0,
          bookingFeeMinor: a.bookingFeeMinor ?? 0,
          paymentFeeMinor: a.paymentFeeMinor ?? 0,
          allocatedNetMinor: a.allocatedNetMinor,
        })),
      });
    }
    return payout.id;
  }

  async function makeSettlement(
    organizationId: string,
    eventId: string,
    row: {
      currency?: string;
      status?: string;
      grossSalesMinor: number;
      platformFeesMinor?: number;
      refundsMinor?: number;
      disputesMinor?: number;
      reserveMinor?: number;
      releasedMinor?: number;
      transferredMinor?: number;
    },
  ): Promise<string> {
    const s = await db!.settlement.create({
      data: {
        organizationId,
        eventId,
        provider: 'razorpay',
        currency: row.currency ?? 'inr',
        status: (row.status ?? 'ELIGIBLE') as never,
        grossSalesMinor: row.grossSalesMinor,
        platformFeesMinor: row.platformFeesMinor ?? 0,
        refundsMinor: row.refundsMinor ?? 0,
        disputesMinor: row.disputesMinor ?? 0,
        reserveMinor: row.reserveMinor ?? 0,
        releasedMinor: row.releasedMinor ?? 0,
        transferredMinor: row.transferredMinor ?? 0,
      },
      select: { id: true },
    });
    return s.id;
  }

  /** An unresolved reversal attempt, which proves ambiguity without moving an amount. */
  async function makeUnresolvedReversal(settlementId: string, status: string) {
    await db!.settlementReversalAttempt.create({
      data: {
        settlementId,
        reason: 'ADJUSTMENT',
        requestedMinor: 1_000,
        currency: 'inr',
        provider: 'razorpay',
        status: status as never,
        idempotencyKey: `uf-${settlementId}-${status}-${Math.random().toString(36).slice(2)}`,
      },
    });
  }

  /**
   * A transfer whose outcome was never established.
   *
   * This is the shape `release()` writes when `createTransfer` throws - proven against the real
   * writer in release-writer.integration-postgres.spec.ts, which is why constructing it here is
   * sound rather than the fixture-shape trap: the writer demonstrably produces it.
   */
  async function makeUnknownTransfer(settlementId: string) {
    await db!.settlementTransferAttempt.create({
      data: {
        settlementId,
        requestedMinor: 5_000,
        currency: 'inr',
        provider: 'razorpay',
        status: 'UNKNOWN',
        lastError: 'socket hang up',
        idempotencyKey: `uf-t-${settlementId}-${Math.random().toString(36).slice(2)}`,
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
    finance = new UnifiedFinanceService(
      db as never,
      {
        // Platform admin short-circuits membership; cross-tenant denial is tested separately.
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
    const settlements = await db.settlement.findMany({
      where: { organizationId: { in: orgIds } },
      select: { id: true },
    });
    for (const s of settlements) {
      await db.settlementReversalAttempt
        .deleteMany({ where: { settlementId: s.id } })
        .catch(() => {});
    }
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

  const only = (result: Awaited<ReturnType<UnifiedFinanceService['forOrganization']>>) => {
    expect(result.currencies).toHaveLength(1);
    return result.currencies[0];
  };

  // ── 1 ────────────────────────────────────────────────────────────────────────────
  it('1. platform-only organization: authoritative totals and decomposition', async () => {
    if (!guard()) return;
    const org = await makeOrg('platform-only');
    const ev = await makeEvent(org, 'ev');
    await makePayout(
      org,
      {
        eventId: ev,
        grossMinor: 91_400,
        bookingFeeMinor: 1_300,
        paymentFeeMinor: 900,
        refundMinor: 7_300,
        netMinor: 76_500,
      },
      [
        {
          bookingId: 'bk-1',
          eventId: ev,
          subtotalMinor: 91_400,
          discountMinor: 4_900,
          organizerFeeMinor: 2_700,
          refundShareMinor: 7_300,
          bookingFeeMinor: 1_300,
          paymentFeeMinor: 900,
          allocatedNetMinor: 76_500,
        },
      ],
    );

    const g = only(await finance.forOrganization(admin, org));
    expect(g.currency).toBe('INR');
    expect(g.summary.entitlementMinor).toBe(76_500);
    expect(g.summary.paidMinor).toBe(76_500);
    // Only the organizer fee came out; the 2 200 of customer-borne fees did not.
    expect(g.summary.deductedFeesMinor).toBe(2_700);
    expect(g.summary.movement).toBeUndefined();

    const e = g.entries[0].entry;
    expect(e.money.grossFaceValueMinor).toBe(91_400);
    expect(e.money.discountMinor).toBe(4_900);
    expect(e.money.refundsMinor).toBe(7_300);
    expect(e.attribution).toBe('AUTHORITATIVE');
    expect(e.eventId).toBe(ev);
    expect(e.state).toBe('PAID');
    expect(g.warnings.filter((w) => w.category === 'FINANCIAL_INTEGRITY')).toEqual([]);
  }, 60_000);

  // ── 2 ────────────────────────────────────────────────────────────────────────────
  it('2. allocation-backed period payout: three events, each discoverable', async () => {
    if (!guard()) return;
    const org = await makeOrg('period');
    const [a, b, c, unrelated] = [
      await makeEvent(org, 'p-a'),
      await makeEvent(org, 'p-b'),
      await makeEvent(org, 'p-c'),
      await makeEvent(org, 'p-unrelated'),
    ];
    await makePayout(org, { eventId: null, grossMinor: 60_000, netMinor: 60_000 }, [
      { bookingId: 'bk-a', eventId: a, subtotalMinor: 10_000, allocatedNetMinor: 10_000 },
      { bookingId: 'bk-b', eventId: b, subtotalMinor: 20_000, allocatedNetMinor: 20_000 },
      { bookingId: 'bk-c', eventId: c, subtotalMinor: 30_000, allocatedNetMinor: 30_000 },
    ]);

    const orgWide = only(await finance.forOrganization(admin, org));
    expect(orgWide.summary.entitlementMinor).toBe(60_000);
    const parent = orgWide.entries[0].entry;
    // The payout names no event at all - this is the gap allocations close.
    expect(parent.eventId).toBeNull();
    expect(parent.coveredEventIds).toEqual([a, b, c].sort());

    /*
      THE SCENARIO THAT MATTERS. An event-scoped query must find a period payout through its
      allocations. A filter on `Payout.eventId` alone would return nothing here.
    */
    for (const eventId of [a, b, c]) {
      const scoped = only(await finance.forOrganization(admin, org, eventId));
      expect(scoped.entries).toHaveLength(1);
      expect(scoped.entries[0].entry.sourceId).toBe(parent.sourceId);
      // Stored totals, not a share recomputed for the event.
      expect(scoped.summary.entitlementMinor).toBe(60_000);
    }

    const none = await finance.forOrganization(admin, org, unrelated);
    expect(none.currencies).toEqual([]);
  }, 60_000);

  // ── 3 ────────────────────────────────────────────────────────────────────────────
  it('3. legacy EVENT payout: attribution authoritative, decomposition absent', async () => {
    if (!guard()) return;
    const org = await makeOrg('legacy-event');
    const ev = await makeEvent(org, 'le');
    await makePayout(org, {
      eventId: ev,
      legacy: true,
      grossMinor: 90_000,
      bookingFeeMinor: 700,
      paymentFeeMinor: 300,
      refundMinor: 5_000,
      netMinor: 80_000,
    });

    const g = only(await finance.forOrganization(admin, org));
    const e = g.entries[0].entry;
    /*
      THE INDEPENDENT-DIMENSIONS RULE. The row names its event, so attribution survives being
      legacy. The decomposition does not, because Payout never stored discount or organizer fee.
    */
    expect(e.attribution).toBe('AUTHORITATIVE');
    expect(e.eventId).toBe(ev);
    expect(e.money.organizerNetMinor).toBe(80_000);
    expect(e.money.grossFaceValueMinor).toBe(90_000);
    expect(e.money.discountMinor).toBeUndefined();
    expect(e.money.fees!.some((f) => f.key === 'PLATFORM')).toBe(false);
    // Through JSON, because a response is serialized.
    expect(JSON.stringify(e.money)).not.toContain('discountMinor');

    const codes = g.warnings.map((w) => w.code);
    expect(codes).toContain('DEDUCTION_DETAIL_UNAVAILABLE');
    expect(codes).not.toContain('EVENT_ATTRIBUTION_UNAVAILABLE');

    // And it is still found when scoped to its event.
    const scoped = only(await finance.forOrganization(admin, org, ev));
    expect(scoped.entries).toHaveLength(1);
  }, 60_000);

  // ── 4 ────────────────────────────────────────────────────────────────────────────
  it('4. legacy PERIOD payout: amount visible, membership unknown, no event claims it', async () => {
    if (!guard()) return;
    const org = await makeOrg('legacy-period');
    const ev = await makeEvent(org, 'lp');
    await makePayout(org, { eventId: null, legacy: true, grossMinor: 45_000, netMinor: 41_000 });

    const g = only(await finance.forOrganization(admin, org));
    const e = g.entries[0].entry;
    expect(e.money.organizerNetMinor).toBe(41_000);
    expect(e.attribution).toBe('UNKNOWN_LEGACY');
    expect(e.coveredEventIds).toBeUndefined();
    // Unknown must not serialize as an authoritative empty set.
    expect(JSON.stringify(e)).not.toContain('coveredEventIds');
    expect(g.warnings.map((w) => w.code).sort()).toEqual([
      'DEDUCTION_DETAIL_UNAVAILABLE',
      'EVENT_ATTRIBUTION_UNAVAILABLE',
    ]);
    // Both are history, not emergencies.
    expect(g.warnings.every((w) => w.category === 'HISTORICAL_LIMITATION')).toBe(true);

    // No event receives fabricated membership.
    const scoped = await finance.forOrganization(admin, org, ev);
    expect(scoped.currencies).toEqual([]);
  }, 60_000);

  // ── 5, 6 ─────────────────────────────────────────────────────────────────────────
  it('5+6. provider-only: entitlement is grossSales, movement is asymmetric', async () => {
    if (!guard()) return;
    const org = await makeOrg('provider-only');
    const ev = await makeEvent(org, 'po');
    await makeSettlement(org, ev, {
      status: 'PARTIALLY_REFUNDED',
      grossSalesMinor: 83_250,
      platformFeesMinor: 6_150,
      refundsMinor: 9_800,
      reserveMinor: 2_500,
      releasedMinor: 71_000,
      transferredMinor: 57_600,
    });

    const g = only(await finance.forOrganization(admin, org));
    const e = g.entries[0].entry;
    /*
      Four different numbers, asserted independently. payableMinor is 0 on this row - it is never
      written outside release() - so a mapping that used it would read zero here.
    */
    expect(e.money.organizerNetMinor).toBe(83_250);
    expect(e.movement).toEqual({
      transferredOutMinor: 71_000,
      recoveredMinor: 13_400,
      stillOutMinor: 57_600,
    });
    expect(e.money.organizerNetMinor).not.toBe(e.movement!.transferredOutMinor);
    expect(e.money.organizerNetMinor).not.toBe(e.movement!.stillOutMinor);
    expect(e.money.organizerNetMinor).not.toBe(e.movement!.recoveredMinor);
    expect(e.money.refundsMinor).toBe(9_800);
    expect(e.money.adjustmentsMinor).toBe(2_500);
    expect(e.money.fees).toEqual([
      { key: 'PLATFORM_COMBINED', amountMinor: 6_150, deducted: true },
    ]);
    expect(e.state).toBe('PARTIALLY_REFUNDED');
  }, 60_000);

  // ── 7 ────────────────────────────────────────────────────────────────────────────
  it('7. refund recorded before any recovery: accounting moved, money did not', async () => {
    if (!guard()) return;
    const org = await makeOrg('refund-no-recovery');
    const ev = await makeEvent(org, 'rnr');
    await makeSettlement(org, ev, {
      status: 'PARTIALLY_REFUNDED',
      grossSalesMinor: 120_000,
      refundsMinor: 35_000,
      releasedMinor: 100_000,
      // Nothing has come back.
      transferredMinor: 100_000,
    });

    const g = only(await finance.forOrganization(admin, org));
    const e = g.entries[0].entry;
    expect(e.money.refundsMinor).toBe(35_000);
    expect(e.movement!.recoveredMinor).toBe(0);
    expect(e.movement!.stillOutMinor).toBe(100_000);
    // The two concepts are present, different, and neither is the other.
    expect(g.summary.refundsMinor).toBe(35_000);
    expect(g.summary.movement!.recoveredMinor).toBe(0);
  }, 60_000);

  // ── 8 ────────────────────────────────────────────────────────────────────────────
  it('8. partial reversal: every integer asserted', async () => {
    if (!guard()) return;
    const org = await makeOrg('partial-reversal');
    const ev = await makeEvent(org, 'pr');
    await makeSettlement(org, ev, {
      status: 'PARTIALLY_REFUNDED',
      grossSalesMinor: 200_000,
      refundsMinor: 90_000,
      releasedMinor: 200_000,
      transferredMinor: 110_000,
    });

    const g = only(await finance.forOrganization(admin, org));
    const e = g.entries[0].entry;
    expect(e.money.organizerNetMinor).toBe(200_000);
    expect(e.movement).toEqual({
      transferredOutMinor: 200_000,
      recoveredMinor: 90_000,
      stillOutMinor: 110_000,
    });
    expect(e.money.refundsMinor).toBe(90_000);
    expect(e.state).toBe('PARTIALLY_REFUNDED');
  }, 60_000);

  // ── 9 ────────────────────────────────────────────────────────────────────────────
  it('9. UNKNOWN reversal: no invented recovery, no invented failure, not PAID', async () => {
    if (!guard()) return;
    const org = await makeOrg('unknown-reversal');
    const ev = await makeEvent(org, 'ur');
    const sid = await makeSettlement(org, ev, {
      status: 'TRANSFERRED',
      grossSalesMinor: 64_500,
      releasedMinor: 64_500,
      transferredMinor: 64_500,
    });
    await makeUnresolvedReversal(sid, 'UNKNOWN');

    const g = only(await finance.forOrganization(admin, org));
    const e = g.entries[0].entry;
    // Ambiguity moves no amount.
    expect(e.movement!.recoveredMinor).toBe(0);
    expect(e.movement!.stillOutMinor).toBe(64_500);
    expect(e.money.organizerNetMinor).toBe(64_500);
    // And it is not a finished state. The source status is still TRANSFERRED underneath.
    expect(e.state).toBe('ATTENTION_REQUIRED');
    expect(e.sourceStatus).toBe('TRANSFERRED');
    expect(g.summary.paidMinor).toBe(0);
    expect(g.summary.attentionMinor).toBe(64_500);
    expect(g.warnings.map((w) => w.code)).toContain('NEEDS_RECONCILIATION');
  }, 60_000);

  it('a transfer whose outcome was never established needs a person', async () => {
    if (!guard()) return;
    /*
      ── MONEY THAT MAY HAVE GONE OUT ─────────────────────────────────────────────────────
      Until the transfer attempt table existed there was no durable evidence of this at all: a
      release that timed out wrote FAILED and nothing recorded that the organizer might already
      hold the money. The read model counted unresolved REVERSALS only, so the larger and more
      dangerous direction raised no flag.
    */
    const org = await makeOrg('unknown-transfer');
    const ev = await makeEvent(org, 'ut');
    const sid = await makeSettlement(org, ev, {
      status: 'TRANSFERRED',
      grossSalesMinor: 70_000,
      releasedMinor: 70_000,
      transferredMinor: 70_000,
    });
    await makeUnknownTransfer(sid);

    const g = only(await finance.forOrganization(admin, org));
    const e = g.entries[0].entry;
    expect(e.state).toBe('ATTENTION_REQUIRED');
    // The stored figures are untouched: ambiguity is reported, never netted off the money.
    expect(e.money.organizerNetMinor).toBe(70_000);
    expect(e.movement!.transferredOutMinor).toBe(70_000);
    expect(g.summary.attentionMinor).toBe(70_000);
    expect(g.summary.paidMinor).toBe(0);
    expect(g.warnings.map((w) => w.code)).toContain('NEEDS_RECONCILIATION');
  }, 60_000);

  it('a SUCCEEDED transfer attempt is not a reason to call anybody', async () => {
    if (!guard()) return;
    // The ordinary case must stay quiet, or the flag means nothing.
    const org = await makeOrg('settled-transfer');
    const ev = await makeEvent(org, 'st');
    const sid = await makeSettlement(org, ev, {
      status: 'TRANSFERRED',
      grossSalesMinor: 48_000,
      releasedMinor: 48_000,
      transferredMinor: 48_000,
    });
    await db!.settlementTransferAttempt.create({
      data: {
        settlementId: sid,
        requestedMinor: 48_000,
        currency: 'inr',
        provider: 'razorpay',
        status: 'SUCCEEDED',
        providerTransferId: 'trf_ok',
        idempotencyKey: `uf-ok-${sid}`,
      },
    });

    const g = only(await finance.forOrganization(admin, org));
    expect(g.entries[0].entry.state).toBe('PAID');
    expect(g.summary.paidMinor).toBe(48_000);
    expect(g.summary.attentionMinor).toBe(0);
  }, 60_000);

  it('9b. REQUESTED and PROCESSING attempts also hold the entry open', async () => {
    if (!guard()) return;
    for (const status of ['REQUESTED', 'PROCESSING']) {
      const org = await makeOrg(`unresolved-${status.toLowerCase()}`);
      const ev = await makeEvent(org, 'u');
      const sid = await makeSettlement(org, ev, {
        status: 'TRANSFERRED',
        grossSalesMinor: 10_000,
        releasedMinor: 10_000,
        transferredMinor: 10_000,
      });
      await makeUnresolvedReversal(sid, status);
      const g = only(await finance.forOrganization(admin, org));
      expect(`${status} ${g.entries[0].entry.state}`).toBe(`${status} ATTENTION_REQUIRED`);
    }
  }, 120_000);

  it('9c. a COMPLETED attempt does not hold the entry open', async () => {
    if (!guard()) return;
    /*
      The inverse. If every attempt counted as unresolved, a settlement whose reversal finished
      cleanly would be stuck needing a person forever - and the query filter would be unproven.
    */
    const org = await makeOrg('resolved-reversal');
    const ev = await makeEvent(org, 'rr');
    const sid = await makeSettlement(org, ev, {
      status: 'TRANSFERRED',
      grossSalesMinor: 10_000,
      releasedMinor: 10_000,
      transferredMinor: 10_000,
    });
    await makeUnresolvedReversal(sid, 'COMPLETED');
    const g = only(await finance.forOrganization(admin, org));
    expect(g.entries[0].entry.state).toBe('PAID');
  }, 60_000);

  // ── 10, 16 ───────────────────────────────────────────────────────────────────────
  it('10+16. contradictory evidence surfaces and is never repaired', async () => {
    if (!guard()) return;
    const org = await makeOrg('contradiction');
    const ev = await makeEvent(org, 'cx');
    // Allocation sums disagree with the stored payout totals.
    await makePayout(org, { eventId: ev, grossMinor: 999, netMinor: 76_500 }, [
      {
        bookingId: 'bk-x',
        eventId: ev,
        subtotalMinor: 91_400,
        discountMinor: 4_900,
        organizerFeeMinor: 2_700,
        refundShareMinor: 7_300,
        allocatedNetMinor: 76_500,
      },
    ]);
    // And a provider row claiming more is still out than was ever sent.
    await makeSettlement(org, await makeEvent(org, 'cx2'), {
      status: 'TRANSFERRED',
      grossSalesMinor: 50_000,
      releasedMinor: 10_000,
      transferredMinor: 40_000,
    });

    const g = only(await finance.forOrganization(admin, org));
    const integrity = g.warnings.filter((w) => w.category === 'FINANCIAL_INTEGRITY');
    expect(integrity.map((w) => w.code)).toContain('EVIDENCE_DISAGREEMENT');
    // The stored figure is reported, not replaced by the allocation-derived one.
    const payoutEntry = g.entries.find((x) => x.path === 'PLATFORM')!.entry;
    expect(payoutEntry.money.grossFaceValueMinor).toBe(999);
    expect(payoutEntry.state).toBe('ATTENTION_REQUIRED');
    // Nothing healthy-looking is emitted for either side.
    expect(g.entries.every((x) => x.entry.state === 'ATTENTION_REQUIRED')).toBe(true);
  }, 60_000);

  // ── 11 ───────────────────────────────────────────────────────────────────────────
  it('11. mixed organization: both paths, no double count', async () => {
    if (!guard()) return;
    const org = await makeOrg('mixed');
    const platformEvent = await makeEvent(org, 'm-platform');
    const providerEvent = await makeEvent(org, 'm-provider');

    await makePayout(
      org,
      {
        eventId: platformEvent,
        grossMinor: 137_900,
        bookingFeeMinor: 2_000,
        paymentFeeMinor: 1_400,
        refundMinor: 11_700,
        netMinor: 114_800,
      },
      [
        {
          bookingId: 'bk-m1',
          eventId: platformEvent,
          subtotalMinor: 137_900,
          discountMinor: 7_300,
          organizerFeeMinor: 4_100,
          refundShareMinor: 11_700,
          bookingFeeMinor: 2_000,
          paymentFeeMinor: 1_400,
          allocatedNetMinor: 114_800,
        },
      ],
    );
    await makeSettlement(org, providerEvent, {
      status: 'PARTIALLY_REFUNDED',
      grossSalesMinor: 83_250,
      platformFeesMinor: 6_150,
      refundsMinor: 9_800,
      releasedMinor: 71_000,
      transferredMinor: 57_600,
    });

    const g = only(await finance.forOrganization(admin, org));
    expect(g.summary.counts).toEqual({ platform: 1, provider: 1 });
    // Each entitlement counted exactly once.
    expect(g.summary.entitlementMinor).toBe(198_050);
    // Not the platform GROSS plus the provider entitlement, the classic double count.
    expect(g.summary.entitlementMinor).not.toBe(137_900 + 83_250);
    // Only deducted lines: 4 100 + 6 150, never the 3 400 customer-borne.
    expect(g.summary.deductedFeesMinor).toBe(10_250);
    // No event is claimed twice.
    expect(g.warnings.filter((w) => w.code === 'DOUBLE_CLAIM')).toEqual([]);
    expect(g.entries.map((x) => x.path).sort()).toEqual(['PLATFORM', 'PROVIDER']);
  }, 60_000);

  // ── 12 ───────────────────────────────────────────────────────────────────────────
  it('12. mixed event scoping: each event returns only its own path', async () => {
    if (!guard()) return;
    const org = await makeOrg('mixed-event');
    const platformEvent = await makeEvent(org, 'me-platform');
    const providerEvent = await makeEvent(org, 'me-provider');
    await makePayout(org, { eventId: platformEvent, grossMinor: 25_000, netMinor: 25_000 }, [
      {
        bookingId: 'bk-me',
        eventId: platformEvent,
        subtotalMinor: 25_000,
        allocatedNetMinor: 25_000,
      },
    ]);
    await makeSettlement(org, providerEvent, {
      status: 'TRANSFERRED',
      grossSalesMinor: 31_750,
      releasedMinor: 31_750,
      transferredMinor: 31_750,
    });

    const p = only(await finance.forOrganization(admin, org, platformEvent));
    expect(p.entries.map((x) => x.path)).toEqual(['PLATFORM']);
    expect(p.summary.entitlementMinor).toBe(25_000);

    const v = only(await finance.forOrganization(admin, org, providerEvent));
    expect(v.entries.map((x) => x.path)).toEqual(['PROVIDER']);
    expect(v.summary.entitlementMinor).toBe(31_750);
  }, 60_000);

  // ── 13 ───────────────────────────────────────────────────────────────────────────
  it('13. multiple currencies: separate groups, no grand total', async () => {
    if (!guard()) return;
    const org = await makeOrg('multi-currency');
    const inrEvent = await makeEvent(org, 'mc-inr');
    const usdEvent = await makeEvent(org, 'mc-usd');
    await makePayout(
      org,
      { eventId: inrEvent, currency: 'INR', grossMinor: 60_000, netMinor: 57_300 },
      [
        {
          bookingId: 'bk-inr',
          eventId: inrEvent,
          currency: 'INR',
          subtotalMinor: 60_000,
          organizerFeeMinor: 2_700,
          allocatedNetMinor: 57_300,
        },
      ],
    );
    await makeSettlement(org, usdEvent, {
      currency: 'usd',
      status: 'TRANSFERRED',
      grossSalesMinor: 42_775,
      platformFeesMinor: 3_025,
      releasedMinor: 31_250,
      transferredMinor: 28_125,
    });

    const result = await finance.forOrganization(admin, org);
    expect(result.currencies.map((c) => c.currency)).toEqual(['INR', 'USD']);
    expect(result.currencies[0].summary.entitlementMinor).toBe(57_300);
    expect(result.currencies[1].summary.entitlementMinor).toBe(42_775);
    // The combined figure exists nowhere in the serialized response.
    expect(JSON.stringify(result)).not.toContain(String(57_300 + 42_775));
    // And there is no field that could hold one.
    expect(Object.keys(result)).toEqual(['currencies']);
  }, 60_000);

  // ── 14 ───────────────────────────────────────────────────────────────────────────
  it('14. proven zero and unavailable are distinguishable through the read path', async () => {
    if (!guard()) return;
    const org = await makeOrg('zero-vs-absent');
    const ev = await makeEvent(org, 'zva');
    // Allocation-backed, proving discount and organizer fee are genuinely zero.
    await makePayout(org, { eventId: ev, currency: 'INR', grossMinor: 50_000, netMinor: 50_000 }, [
      {
        bookingId: 'bk-zero',
        eventId: ev,
        subtotalMinor: 50_000,
        discountMinor: 0,
        organizerFeeMinor: 0,
        allocatedNetMinor: 50_000,
      },
    ]);
    // Legacy, where neither was ever stored.
    await makePayout(org, {
      eventId: ev,
      legacy: true,
      currency: 'INR',
      grossMinor: 50_000,
      netMinor: 50_000,
    });

    const g = only(await finance.forOrganization(admin, org));
    const proven = g.entries.find((x) => x.entry.money.discountMinor !== undefined)!.entry;
    const absent = g.entries.find((x) => x.entry.money.discountMinor === undefined)!.entry;

    expect(proven.money.discountMinor).toBe(0);
    expect(proven.money.fees!.find((f) => f.key === 'PLATFORM')).toEqual({
      key: 'PLATFORM',
      amountMinor: 0,
      deducted: true,
    });

    expect(absent.money.discountMinor).toBeUndefined();
    expect(absent.money.fees!.some((f) => f.key === 'PLATFORM')).toBe(false);
    // Same money, different financial statements, and they survive serialization as different.
    expect(JSON.stringify(proven.money)).toContain('discountMinor');
    expect(JSON.stringify(absent.money)).not.toContain('discountMinor');
  }, 60_000);

  // ── 15 ───────────────────────────────────────────────────────────────────────────
  it('15. customer-borne fees: 1 000 deducted, not 6 000', async () => {
    if (!guard()) return;
    const org = await makeOrg('fee-semantics');
    const ev = await makeEvent(org, 'fs');
    await makePayout(
      org,
      {
        eventId: ev,
        grossMinor: 12_000,
        bookingFeeMinor: 3_000,
        paymentFeeMinor: 2_000,
        netMinor: 11_000,
      },
      [
        {
          bookingId: 'bk-fee',
          eventId: ev,
          subtotalMinor: 12_000,
          organizerFeeMinor: 1_000,
          bookingFeeMinor: 3_000,
          paymentFeeMinor: 2_000,
          allocatedNetMinor: 11_000,
        },
      ],
    );

    const g = only(await finance.forOrganization(admin, org));
    const fees = g.entries[0].entry.money.fees!;
    // All three lines total 6 000...
    expect(fees.reduce((t, f) => t + f.amountMinor, 0)).toBe(6_000);
    // ...and only 1 000 of it came out of the organizer's money.
    expect(g.summary.deductedFeesMinor).toBe(1_000);
    expect(g.summary.entitlementMinor).toBe(11_000);
    // gross - deducted reproduces the net; the naive sum does not.
    expect(12_000 - 1_000).toBe(11_000);
    expect(12_000 - 6_000).not.toBe(11_000);
  }, 60_000);

  // ── allocations loaded whole ─────────────────────────────────────────────────────
  it('loads every allocation under an event scope, not only the scoped ones', async () => {
    if (!guard()) return;
    /*
      A read-path property no in-memory test can check. The producer reconciles allocation sums
      against the stored totals, so if an event scope filtered the allocations it loaded, the
      sums would disagree with the payout by construction - manufacturing an integrity finding
      out of a scoping decision.
    */
    const org = await makeOrg('whole-allocations');
    const a = await makeEvent(org, 'wa-a');
    const b = await makeEvent(org, 'wa-b');
    await makePayout(
      org,
      { eventId: null, grossMinor: 90_000, refundMinor: 4_000, netMinor: 81_000 },
      [
        {
          bookingId: 'bk-wa',
          eventId: a,
          subtotalMinor: 40_000,
          discountMinor: 2_000,
          organizerFeeMinor: 1_500,
          refundShareMinor: 1_500,
          allocatedNetMinor: 35_000,
        },
        {
          bookingId: 'bk-wb',
          eventId: b,
          subtotalMinor: 50_000,
          discountMinor: 1_000,
          organizerFeeMinor: 500,
          refundShareMinor: 2_500,
          allocatedNetMinor: 46_000,
        },
      ],
    );

    const scoped = only(await finance.forOrganization(admin, org, a));
    // No integrity finding: the sums still reconcile because all allocations were loaded.
    expect(scoped.warnings.filter((w) => w.category === 'FINANCIAL_INTEGRITY')).toEqual([]);
    expect(scoped.entries[0].entry.state).toBe('PAID');
    // The decomposition is the WHOLE payout's, which is what the stored totals describe.
    expect(scoped.entries[0].entry.money.discountMinor).toBe(3_000);
    expect(scoped.entries[0].entry.coveredEventIds).toEqual([a, b].sort());
  }, 60_000);

  it('17. per-path subtotals add back to the combined total, through the read path', async () => {
    if (!guard()) return;
    /*
      The organizer Finance page shows the platform ladder and the provider side separately, so
      the split has to be right where it is actually produced - not only in the pure composer.
      Asymmetric figures again, so a wrong split cannot coincide with a right one.
    */
    const org = await makeOrg('path-split');
    const platformEvent = await makeEvent(org, 'ps-platform');
    const providerEvent = await makeEvent(org, 'ps-provider');

    await makePayout(
      org,
      { eventId: platformEvent, grossMinor: 137_900, refundMinor: 11_700, netMinor: 114_800 },
      [
        {
          bookingId: 'bk-ps',
          eventId: platformEvent,
          subtotalMinor: 137_900,
          discountMinor: 7_300,
          organizerFeeMinor: 4_100,
          refundShareMinor: 11_700,
          allocatedNetMinor: 114_800,
        },
      ],
    );
    await makeSettlement(org, providerEvent, {
      status: 'PARTIALLY_REFUNDED',
      grossSalesMinor: 83_250,
      platformFeesMinor: 6_150,
      refundsMinor: 9_800,
      releasedMinor: 71_000,
      transferredMinor: 57_600,
    });

    const g = only(await finance.forOrganization(admin, org));
    const platform = g.paths.find((p) => p.path === 'PLATFORM')!;
    const provider = g.paths.find((p) => p.path === 'PROVIDER')!;

    expect(platform.entitlementMinor).toBe(114_800);
    expect(provider.entitlementMinor).toBe(83_250);
    // The parts add back to the whole.
    expect(platform.entitlementMinor + provider.entitlementMinor).toBe(g.summary.entitlementMinor);
    // Movement belongs to the provider route only; the platform ledger reports none.
    expect(platform.movement).toBeUndefined();
    expect(provider.movement).toEqual({
      transferredOutMinor: 71_000,
      recoveredMinor: 13_400,
      stillOutMinor: 57_600,
    });
    // And the deducted fees stay with their own route.
    expect(platform.deductedFeesMinor).toBe(4_100);
    expect(provider.deductedFeesMinor).toBe(6_150);
  }, 60_000);

  it('18. lists only the settlement routes the organization actually uses', async () => {
    if (!guard()) return;
    const org = await makeOrg('one-route');
    const ev = await makeEvent(org, 'or');
    await makePayout(org, { eventId: ev, grossMinor: 10_000, netMinor: 10_000 }, [
      { bookingId: 'bk-or', eventId: ev, subtotalMinor: 10_000, allocatedNetMinor: 10_000 },
    ]);

    const g = only(await finance.forOrganization(admin, org));
    // One route, not two with a zeroed provider - a zero would assert something about a route
    // this organization does not use.
    expect(g.paths.map((p) => p.path)).toEqual(['PLATFORM']);
  }, 60_000);

  // ── empty ────────────────────────────────────────────────────────────────────────
  it('returns an honest empty result for an organization with no finance', async () => {
    if (!guard()) return;
    const org = await makeOrg('empty');
    const result = await finance.forOrganization(admin, org);
    // Distinguishable from a failure by the caller: a shape, not an error.
    expect(result).toEqual({ currencies: [] });
  }, 60_000);
});
