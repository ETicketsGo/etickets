import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TransferReconciliationService } from './transfer-reconciliation.service';

/**
 * integration-real-postgres — can an authorized operator find money nobody can account for?
 *
 * Three different shapes of trouble, which an operator thinks of as one question:
 *
 *   a transfer we asked for and never learned the outcome of
 *   two sources of truth that do not match
 *   a payout a guard stopped, and why
 *
 * Also asserts the two properties that make the screen safe to open: it never contacts a
 * provider, and it cannot change anything.
 */
function loadDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const p of ['../../../../.env', '../../../../../.env']) {
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

const COUNTRY = 'Queueland';

describe('integration-real-postgres: the operator unresolved-money queue', () => {
  const url = loadDatabaseUrl();
  let db: Client | null = null;
  let service: TransferReconciliationService;
  let available = false;
  let orgId = '';
  let otherOrgId = '';
  let seq = 0;

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
    const a = await db!.organization.create({
      data: { name: `Q ${stamp}`, slug: `q-${stamp}`, status: 'APPROVED' },
    });
    const b = await db!.organization.create({
      data: { name: `Q2 ${stamp}`, slug: `q2-${stamp}`, status: 'APPROVED' },
    });
    orgId = a.id;
    otherOrgId = b.id;
    service = new TransferReconciliationService(db as never);
  }, 60_000);

  afterAll(async () => {
    if (!available || !db) return;
    for (const id of [orgId, otherOrgId]) {
      const rows = await db.settlement.findMany({ where: { organizationId: id } });
      for (const s of rows) {
        await db.settlementReconciliationFinding
          .deleteMany({ where: { settlementId: s.id } })
          .catch(() => {});
        await db.settlementTransferAttempt
          .deleteMany({ where: { settlementId: s.id } })
          .catch(() => {});
      }
      await db.settlement.deleteMany({ where: { organizationId: id } }).catch(() => {});
      await db.event.deleteMany({ where: { organizationId: id } }).catch(() => {});
      await db.venue.deleteMany({ where: { organizationId: id } }).catch(() => {});
      await db.organization.deleteMany({ where: { id } }).catch(() => {});
    }
    await db.$disconnect();
  }, 60_000);

  async function settlementFor(organizationId: string, over: Record<string, unknown> = {}) {
    seq += 1;
    const venue = await db!.venue.create({
      data: { organizationId, name: `QV${seq}`, city: 'Queuetown', country: COUNTRY },
    });
    const event = await db!.event.create({
      data: {
        organizationId,
        venueId: venue.id,
        title: `Q ${seq}`,
        slug: `q-${Date.now()}-${seq}`,
        category: 'Music',
        status: 'COMPLETED',
      },
    });
    return db!.settlement.create({
      data: {
        organizationId,
        eventId: event.id,
        provider: 'razorpay',
        currency: 'inr',
        status: 'FAILED',
        grossSalesMinor: 40_000,
        ...over,
      },
    });
  }

  async function unknownAttempt(organizationId: string) {
    const s = await settlementFor(organizationId);
    const a = await db!.settlementTransferAttempt.create({
      data: {
        settlementId: s.id,
        requestedMinor: 40_000,
        currency: 'inr',
        provider: 'razorpay',
        idempotencyKey: `settlement_${s.id}_0`,
        status: 'UNKNOWN',
        lastError: 'No usable answer from the provider: socket hang up',
      },
    });
    return { settlement: s, attempt: a };
  }

  const maybe = (name: string, fn: () => Promise<void>, timeout = 60_000) =>
    it(
      name,
      async () => {
        if (!available) {
          console.warn(`SKIPPED (no database): ${name}`);
          return;
        }
        await fn();
      },
      timeout,
    );

  maybe('shows a transfer whose outcome was never learned, with its age and reason', async () => {
    const { attempt, settlement } = await unknownAttempt(orgId);

    const q = await service.operatorQueue({ organizationId: orgId });
    const row = q.unresolvedTransfers.find((r) => r.attemptId === attempt.id);

    expect(row).toBeDefined();
    expect(row).toMatchObject({
      settlementId: settlement.id,
      organizationId: orgId,
      status: 'UNKNOWN',
      amountMinor: 40_000,
      currency: 'inr',
      provider: 'razorpay',
      providerTransferId: null,
    });
    // What an operator needs to decide whether to chase it.
    expect(row!.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(row!.reason).toMatch(/socket hang up/);
    // The operation identity is ours and identifies nothing else, so it is safe to show.
    expect(row!.operationId).toBe(`settlement_${settlement.id}_0`);
  });

  maybe('shows an open disagreement, and stops showing it once resolved', async () => {
    const { attempt, settlement } = await unknownAttempt(orgId);
    await db!.settlementReconciliationFinding.create({
      data: {
        settlementId: settlement.id,
        organizationId: orgId,
        transferAttemptId: attempt.id,
        kind: 'AMOUNT_DISAGREES',
        localStatus: 'UNKNOWN',
        localAmountMinor: 40_000,
        localCurrency: 'inr',
        providerDisposition: 'SENT',
        providerAmountMinor: 39_000,
        detail: 'We asked for 40000; the provider reports 39000.',
      },
    });

    const open = await service.operatorQueue({ organizationId: orgId });
    const f = open.openFindings.find((r) => r.attemptId === attempt.id);
    expect(f).toMatchObject({
      kind: 'AMOUNT_DISAGREES',
      localAmountMinor: 40_000,
      providerAmountMinor: 39_000,
      providerDisposition: 'SENT',
      observationCount: 1,
    });
    expect(f!.detail).toMatch(/40000.*39000/);

    await db!.settlementReconciliationFinding.updateMany({
      where: { transferAttemptId: attempt.id },
      data: { status: 'RESOLVED', resolvedAt: new Date() },
    });

    // Out of the queue, but still in the table - the evidence is not the queue.
    const after = await service.operatorQueue({ organizationId: orgId });
    expect(after.openFindings.find((r) => r.attemptId === attempt.id)).toBeUndefined();
    expect(
      await db!.settlementReconciliationFinding.count({ where: { transferAttemptId: attempt.id } }),
    ).toBe(1);
  });

  maybe('shows a blocked payout with the reason a person must act on', async () => {
    const s = await settlementFor(orgId, {
      status: 'BLOCKED',
      blockedReason: 'A previous transfer attempt did not complete and its outcome is unknown.',
    });

    const q = await service.operatorQueue({ organizationId: orgId });
    const row = q.blockedSettlements.find((r) => r.settlementId === s.id);
    expect(row).toBeDefined();
    expect(row!.reason).toMatch(/outcome is unknown/i);
    expect(row!.ageSeconds).toBeGreaterThanOrEqual(0);
  });

  maybe('never shows one organization the money of another', async () => {
    /*
      The queue is an operator surface, but `organizationId` still narrows rather than widens.
      A scoped read must not become a way to learn that another organization has a problem.
    */
    const mine = await unknownAttempt(orgId);
    const theirs = await unknownAttempt(otherOrgId);

    const q = await service.operatorQueue({ organizationId: orgId });
    const ids = q.unresolvedTransfers.map((r) => r.attemptId);
    expect(ids).toContain(mine.attempt.id);
    expect(ids).not.toContain(theirs.attempt.id);
    expect(q.unresolvedTransfers.every((r) => r.organizationId === orgId)).toBe(true);
    expect(q.openFindings.every((r) => r.organizationId === orgId)).toBe(true);
    expect(q.blockedSettlements.every((r) => r.organizationId === orgId)).toBe(true);
  });

  maybe('orders by age, oldest first, and bounds the page', async () => {
    const first = await unknownAttempt(orgId);
    const second = await unknownAttempt(orgId);
    const q = await service.operatorQueue({ organizationId: orgId });
    const ids = q.unresolvedTransfers.map((r) => r.attemptId);
    expect(ids.indexOf(first.attempt.id)).toBeLessThan(ids.indexOf(second.attempt.id));

    const huge = await service.operatorQueue({ organizationId: orgId, limit: 10_000 });
    expect(huge.unresolvedTransfers.length).toBeLessThanOrEqual(200);
    const tiny = await service.operatorQueue({ organizationId: orgId, limit: 1 });
    expect(tiny.unresolvedTransfers).toHaveLength(1);
  });

  maybe('changes nothing, and asks no provider anything', async () => {
    /*
      Opening a screen must not move money, and must not turn into outbound calls about money.
      The service is constructed with Prisma ALONE - there is no provider to call, which is a
      stronger statement than counting calls.
    */
    const { attempt, settlement } = await unknownAttempt(orgId);
    const before = await db!.settlementTransferAttempt.findUnique({ where: { id: attempt.id } });
    const sBefore = await db!.settlement.findUnique({ where: { id: settlement.id } });

    await service.operatorQueue({ organizationId: orgId });
    await service.operatorQueue({ organizationId: orgId });

    const after = await db!.settlementTransferAttempt.findUnique({ where: { id: attempt.id } });
    const sAfter = await db!.settlement.findUnique({ where: { id: settlement.id } });
    expect(after).toEqual(before);
    expect(sAfter.releasedMinor).toBe(sBefore.releasedMinor);
    expect(sAfter.transferredMinor).toBe(sBefore.transferredMinor);
    expect(sAfter.status).toBe(sBefore.status);
  });

  maybe('shows nothing for an organization with nothing wrong', async () => {
    const empty = await service.operatorQueue({ organizationId: 'org-that-does-not-exist' });
    expect(empty.unresolvedTransfers).toEqual([]);
    expect(empty.openFindings).toEqual([]);
    expect(empty.blockedSettlements).toEqual([]);
  });
});
