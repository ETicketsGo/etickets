import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SettlementService } from './settlement.service';
import { TransferReconciliationService } from './transfer-reconciliation.service';
import { UnifiedFinanceService } from '../../finance/unified-finance.service';
import type { LocalTransferFacts } from './transfer-reconciliation';
import type { TransferState } from '../provider/payment-provider.interface';

/**
 * integration-real-postgres — the whole payout lifecycle, through the production services.
 *
 * ── WHAT THIS IS FOR ───────────────────────────────────────────────────────────────────
 * Everything built over this workstream has been proven in pieces. This proves the pieces work
 * TOGETHER, in one continuous story, against a real database and through the real services:
 *
 *   entitlement -> release -> durable attempt -> provider outcome -> movement recorded
 *   -> Finance shows it -> partial recovery -> Finance shows that
 *   -> a second payout goes uncertain -> reconciliation finding -> operator queue
 *   -> observation -> manual disposition -> Finance is clean again
 *
 * No step constructs the row the next step wants to read. Each one is produced by the service
 * that produces it in production.
 *
 * ── THE PROVIDER IS A CONTROLLED DOUBLE ────────────────────────────────────────────────
 * Explicitly. It decides what "the provider said" so the branches can be driven, and it proves
 * NOTHING about how Stripe or Razorpay behave. No external call is made anywhere in this file.
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

const COUNTRY = 'Lifecycleland';
const actor = { id: 'ops-lifecycle' };
const admin = { id: 'uf-admin', roles: ['PLATFORM_ADMIN'], isPlatformAdmin: true } as never;

describe('integration-real-postgres: the payout lifecycle, end to end', () => {
  const url = loadDatabaseUrl();
  let db: Client | null = null;
  let available = false;
  let orgId = '';
  let seq = 0;

  let settlements: SettlementService;
  let reconciliation: TransferReconciliationService;
  let finance: UnifiedFinanceService;

  /** Everything the controlled double was asked to do, so the story can be checked. */
  const transferCalls: Array<Record<string, unknown>> = [];
  let transferBehaviour: () => unknown = () => ({
    kind: 'ACCEPTED',
    transferId: `trf_${Date.now()}`,
    raw: {},
  });
  let reversalBehaviour: (req: Record<string, unknown>) => unknown = (req) => ({
    kind: 'CONFIRMED',
    confirmedMinor: req.amountMinor as number,
    reversalId: `rvsl_${Date.now()}`,
    raw: {},
  });

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
      data: { name: `Life ${stamp}`, slug: `life-${stamp}`, status: 'APPROVED' },
    });
    orgId = org.id;

    const provider = {
      name: 'stripe',
      capabilities: { supportsIdempotentTransfer: true, supportsTransferStatusQuery: false },
      createTransfer: async (req: Record<string, unknown>) => {
        transferCalls.push(req);
        return transferBehaviour();
      },
      reverseTransfer: async (req: Record<string, unknown>) => reversalBehaviour(req),
    };

    settlements = new SettlementService(
      db as never,
      { record: async () => undefined } as never,
      {
        send: async () => undefined,
        sendCritical: async () => undefined,
        fanOutCritical: async () => 0,
      } as never,
      {
        get: (key: string) => (key === 'PAYOUT_EXECUTION_ENABLED' ? true : 0),
      } as never,
      { get: () => provider } as never,
    );
    reconciliation = new TransferReconciliationService(
      db as never,
      {
        record: async () => undefined,
      } as never,
    );
    finance = new UnifiedFinanceService(
      db as never,
      {
        // Platform admin short-circuits membership; cross-tenant denial is tested separately.
        assertMember: async () => undefined,
        isPlatformAdmin: () => true,
      } as never,
    );
  }, 90_000);

  afterAll(async () => {
    if (!available || !db) return;
    const rows = await db.settlement.findMany({ where: { organizationId: orgId } });
    for (const s of rows) {
      await db.settlementReconciliationFinding
        .deleteMany({ where: { settlementId: s.id } })
        .catch(() => {});
      await db.settlementTransferAttempt
        .deleteMany({ where: { settlementId: s.id } })
        .catch(() => {});
      await db.settlementReversalAttempt
        .deleteMany({ where: { settlementId: s.id } })
        .catch(() => {});
    }
    await db.settlement.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.event.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.venue.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
    await db.$disconnect();
  }, 90_000);

  /** An organizer has earned money and the settlement is approved for release. */
  async function approvedSettlement(grossSalesMinor: number) {
    seq += 1;
    const venue = await db!.venue.create({
      data: { organizationId: orgId, name: `LV${seq}`, city: 'Lifetown', country: COUNTRY },
    });
    const event = await db!.event.create({
      data: {
        organizationId: orgId,
        venueId: venue.id,
        title: `Life ${seq}`,
        slug: `life-${Date.now()}-${seq}`,
        category: 'Music',
        status: 'COMPLETED',
      },
    });
    return db!.settlement.create({
      data: {
        organizationId: orgId,
        eventId: event.id,
        provider: 'stripe',
        currency: 'inr',
        status: 'APPROVED',
        grossSalesMinor,
        connectedAccountId: `acct_life_${seq}`,
      },
    });
  }

  const financeFor = async (eventId: string) => {
    const r = await finance.forOrganization(admin, orgId, eventId);
    return r.currencies[0];
  };

  it('carries one organizer from entitlement to a clean Finance page, through every state', async () => {
    if (!available) {
      console.warn('SKIPPED (no database): payout lifecycle');
      return;
    }

    // ── 1. a payout that works ────────────────────────────────────────────────────
    const paid = await approvedSettlement(120_000);
    transferBehaviour = () => ({ kind: 'ACCEPTED', transferId: 'trf_life_1', raw: {} });
    await settlements.release(actor as never, paid.id, 'first payout');

    const afterRelease = await db!.settlement.findUnique({ where: { id: paid.id } });
    expect(afterRelease.status).toBe('TRANSFERRED');
    expect(afterRelease.releasedMinor).toBe(120_000);
    expect(afterRelease.transferredMinor).toBe(120_000);

    // The durable attempt exists, and says what the provider proved.
    const [attempt1] = await db!.settlementTransferAttempt.findMany({
      where: { settlementId: paid.id },
    });
    expect(attempt1).toMatchObject({ status: 'SUCCEEDED', providerTransferId: 'trf_life_1' });
    // The request carried the operation identity we chose.
    expect(transferCalls.at(-1)).toMatchObject({
      amountMinor: 120_000,
      idempotencyKey: `settlement_${paid.id}_0`,
    });

    // ── 2. Finance shows the movement ─────────────────────────────────────────────
    let f = await financeFor(paid.eventId);
    expect(f.entries[0].entry.state).toBe('PAID');
    expect(f.entries[0].entry.movement).toEqual({
      transferredOutMinor: 120_000,
      recoveredMinor: 0,
      stillOutMinor: 120_000,
    });

    // ── 3. a refund claws part of it back ─────────────────────────────────────────
    await settlements.applyRefund(paid.eventId, 'inr', 30_000);

    const afterRefund = await db!.settlement.findUnique({ where: { id: paid.id } });
    // The invariant: what is still out is what went out, less what came back.
    expect(afterRefund.releasedMinor).toBe(120_000);
    expect(afterRefund.transferredMinor).toBe(90_000);

    f = await financeFor(paid.eventId);
    expect(f.entries[0].entry.movement).toEqual({
      transferredOutMinor: 120_000,
      recoveredMinor: 30_000,
      stillOutMinor: 90_000,
    });
    // Recovery is not a refund total; they are different questions.
    expect(f.entries[0].entry.money.refundsMinor).toBe(30_000);

    // ── 4. a second payout goes uncertain ─────────────────────────────────────────
    const lost = await approvedSettlement(75_000);
    transferBehaviour = () => ({
      kind: 'INDETERMINATE',
      raw: { type: 'StripeConnectionError', message: 'connection reset by peer' },
    });
    await expect(settlements.release(actor as never, lost.id, 'second payout')).rejects.toThrow();

    const [attempt2] = await db!.settlementTransferAttempt.findMany({
      where: { settlementId: lost.id },
    });
    // UNKNOWN, never FAILED: the money may already be with the organizer.
    expect(attempt2.status).toBe('UNKNOWN');
    expect(attempt2.lastError).toMatch(/connection reset by peer/);
    const lostRow = await db!.settlement.findUnique({ where: { id: lost.id } });
    expect(lostRow.releasedMinor).toBe(0);

    // ── 5. reconciliation cannot ask, and says so ─────────────────────────────────
    const local: LocalTransferFacts = {
      attemptId: attempt2.id,
      settlementId: lost.id,
      organizationId: orgId,
      status: 'UNKNOWN',
      requestedMinor: 75_000,
      currency: 'inr',
      providerTransferId: null,
      idempotencyKey: attempt2.idempotencyKey,
      destinationAccountId: lostRow.connectedAccountId,
    };
    const cannotAsk = await reconciliation.reconcileOne(local, null);
    expect(cannotAsk).toMatchObject({ kind: 'FINDING', finding: 'CANNOT_BE_ASKED' });

    // ── 6. it reaches the operator queue ──────────────────────────────────────────
    const queue = await reconciliation.operatorQueue({ organizationId: orgId });
    expect(queue.unresolvedTransfers.map((r) => r.attemptId)).toContain(attempt2.id);
    const queued = queue.openFindings.find((r) => r.attemptId === attempt2.id);
    expect(queued).toMatchObject({ kind: 'CANNOT_BE_ASKED' });
    expect(queued!.ageSeconds).toBeGreaterThanOrEqual(0);

    // ── 7. and it makes Finance ask for a person ──────────────────────────────────
    let lostFinance = await financeFor(lost.eventId);
    expect(lostFinance.entries[0].entry.state).toBe('ATTENTION_REQUIRED');
    // Entitlement is untouched by the uncertainty.
    expect(lostFinance.entries[0].entry.money.organizerNetMinor).toBe(75_000);

    // ── 8. observation gets an answer, but not a conclusive one ─────────────────
    const pending = {
      getTransferState: async (): Promise<TransferState> => ({
        transferId: null,
        disposition: 'PENDING',
        amountMinor: null,
        currency: null,
        providerStatusRaw: 'processing',
      }),
    };
    const moneyBefore = await db!.settlement.findUnique({ where: { id: lost.id } });
    const observed = await reconciliation.reconcileOne(local, pending);
    expect(observed).toMatchObject({ kind: 'FINDING', finding: 'STILL_UNRESOLVED' });

    const moneyAfter = await db!.settlement.findUnique({ where: { id: lost.id } });
    // OBSERVATION MOVES NOTHING, whatever it learns.
    expect(moneyAfter.releasedMinor).toBe(moneyBefore.releasedMinor);
    expect(moneyAfter.transferredMinor).toBe(moneyBefore.transferredMinor);
    // Still somebody's problem.
    expect((await reconciliation.openFindingCounts([lost.id])).get(lost.id)).toBeGreaterThanOrEqual(
      1,
    );

    // ── 9. a person establishes it with the provider and dispositions it ────────
    const open = await db!.settlementReconciliationFinding.findMany({
      where: { transferAttemptId: attempt2.id, status: 'OPEN' },
    });
    expect(open.length).toBeGreaterThan(0);

    // A claim about the provider that cites nothing is refused, even from an operator.
    const unevidenced = await reconciliation.resolveFinding(actor, open[0].id, {
      resolution: 'PROVIDER_CONFIRMED_SENT',
      note: 'Fairly sure this one went through in the end.',
    });
    expect(unevidenced.resolved).toBe(false);

    for (const o of open) {
      const out = await reconciliation.resolveFinding(actor, o.id, {
        resolution: 'PROVIDER_CONFIRMED_SENT',
        note: 'Provider dashboard shows this payout against the linked account.',
        evidenceRef: 'trf_life_2',
      });
      expect(out.resolved).toBe(true);
    }

    // ── 10. the queue is clear, the evidence is not ─────────────────────────
    const afterQueue = await reconciliation.operatorQueue({ organizationId: orgId });
    expect(afterQueue.openFindings.filter((r) => r.attemptId === attempt2.id)).toEqual([]);
    const kept = await db!.settlementReconciliationFinding.findMany({
      where: { transferAttemptId: attempt2.id },
    });
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((k: { status: string }) => k.status === 'RESOLVED')).toBe(true);
    expect(
      kept.some(
        (k: { resolutionEvidenceRef: string | null }) => k.resolutionEvidenceRef === 'trf_life_2',
      ),
    ).toBe(true);

    // ── 11. the exception is closed; the UNKNOWN transfer is not ─────────────────
    lostFinance = await financeFor(lost.eventId);
    /*
        A DELIBERATE AND IMPORTANT CONSEQUENCE.

        The operator queue is clear - nobody needs to investigate any more. But Finance still
        says ATTENTION_REQUIRED, because the transfer ATTEMPT is still UNKNOWN, and a disposition
        does not change that. Resolving a finding says "a person has decided how to treat this
        exception". It does not say "the money moved", and it must not quietly make the ledger
        agree with somebody's conclusion.

        Catching the ledger up is a separate financial operation with its own authority, and it
        does not exist yet - deliberately, because nobody has decided who may perform it. Until
        it does, a transfer whose outcome was never established keeps asking, which is the
        conservative direction.
      */
    expect(lostFinance.entries[0].entry.state).toBe('ATTENTION_REQUIRED');
    const stillUnknown = await db!.settlementTransferAttempt.findUnique({
      where: { id: attempt2.id },
    });
    expect(stillUnknown.status).toBe('UNKNOWN');
    // No OPEN finding though: the investigation is over even though the money question is not.
    expect((await reconciliation.openFindingCounts([lost.id])).get(lost.id)).toBeUndefined();

    const finalLost = await db!.settlement.findUnique({ where: { id: lost.id } });
    expect(finalLost.releasedMinor).toBe(0);
    expect(finalLost.transferredMinor).toBe(0);

    // ── 12. the first organizer's money is exactly where we left it ───────────────
    const finalPaid = await db!.settlement.findUnique({ where: { id: paid.id } });
    expect(finalPaid.releasedMinor).toBe(120_000);
    expect(finalPaid.transferredMinor).toBe(90_000);
    // The invariant, one last time, after everything above.
    const confirmed = await db!.settlementReversalAttempt.aggregate({
      where: { settlementId: paid.id, status: 'COMPLETED' },
      _sum: { confirmedMinor: true },
    });
    expect(finalPaid.transferredMinor).toBe(
      finalPaid.releasedMinor - (confirmed._sum.confirmedMinor ?? 0),
    );
  }, 180_000);
});
