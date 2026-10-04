import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TransferReconciliationService } from './transfer-reconciliation.service';
import type { LocalTransferFacts } from './transfer-reconciliation';
import type { TransferState } from '../provider/payment-provider.interface';

/**
 * integration-real-postgres — four channels of evidence about one transfer, converging.
 *
 * A transfer can be spoken about by four different things, in any order:
 *
 *   1. the synchronous provider answer
 *   2. a webhook, possibly late, possibly twice
 *   3. a status query during reconciliation
 *   4. an authorized person, dispositioning the exception
 *
 * Whatever order they arrive in, there must be ONE financial movement, no duplicate payout, no
 * state that goes backwards, and an audit trail that still explains what happened.
 *
 * The provider is a controlled double throughout. It proves what WE do with evidence, never what
 * any provider would say.
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

const COUNTRY = 'Convergeland';

describe('integration-real-postgres: evidence convergence', () => {
  const url = loadDatabaseUrl();
  let db: Client | null = null;
  let service: TransferReconciliationService;
  let available = false;
  let orgId = '';
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
    const org = await db!.organization.create({
      data: { name: `Conv ${stamp}`, slug: `conv-${stamp}`, status: 'APPROVED' },
    });
    orgId = org.id;
    service = new TransferReconciliationService(
      db as never,
      {
        record: async () => undefined,
      } as never,
    );
  }, 60_000);

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
    }
    await db.settlement.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.event.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.venue.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
    await db.$disconnect();
  }, 60_000);

  const AMOUNT = 80_000;

  /** Channel 1 ended in INDETERMINATE: the money may or may not have gone. */
  async function indeterminateTransfer() {
    seq += 1;
    const venue = await db!.venue.create({
      data: { organizationId: orgId, name: `CV${seq}`, city: 'Convtown', country: COUNTRY },
    });
    const event = await db!.event.create({
      data: {
        organizationId: orgId,
        venueId: venue.id,
        title: `Conv ${seq}`,
        slug: `conv-${Date.now()}-${seq}`,
        category: 'Music',
        status: 'COMPLETED',
      },
    });
    const settlement = await db!.settlement.create({
      data: {
        organizationId: orgId,
        eventId: event.id,
        provider: 'stripe',
        currency: 'inr',
        status: 'FAILED',
        grossSalesMinor: AMOUNT,
        releasedMinor: 0,
        transferredMinor: 0,
      },
    });
    const attempt = await db!.settlementTransferAttempt.create({
      data: {
        settlementId: settlement.id,
        requestedMinor: AMOUNT,
        currency: 'inr',
        provider: 'stripe',
        idempotencyKey: `settlement_${settlement.id}_0`,
        status: 'UNKNOWN',
        lastError: 'No usable answer from the provider; it may or may not have sent the money.',
      },
    });
    const local: LocalTransferFacts = {
      attemptId: attempt.id,
      settlementId: settlement.id,
      organizationId: orgId,
      status: 'UNKNOWN',
      requestedMinor: AMOUNT,
      currency: 'inr',
      providerTransferId: null,
      idempotencyKey: attempt.idempotencyKey,
      destinationAccountId: null,
    };
    return { settlement, attempt, local };
  }

  /** Channel 2: a webhook proving acceptance, applied the way the release path applies one. */
  async function webhookSaysAccepted(settlementId: string, attemptId: string, transferId: string) {
    /*
      Guarded on the attempt still being UNRESOLVED and the settlement not already carrying this
      transfer, which is what makes a duplicate delivery a no-op rather than a second movement.
    */
    return db!.$transaction(async (tx: Client) => {
      const claimed = await tx.settlementTransferAttempt.updateMany({
        where: { id: attemptId, status: { in: ['UNKNOWN', 'REQUESTED'] } },
        data: { status: 'SUCCEEDED', providerTransferId: transferId, respondedAt: new Date() },
      });
      if (claimed.count !== 1) return { applied: false };
      await tx.settlement.update({
        where: { id: settlementId },
        data: {
          status: 'TRANSFERRED',
          providerTransferId: transferId,
          releasedMinor: { increment: AMOUNT },
          transferredMinor: { increment: AMOUNT },
          releasedAt: new Date(),
        },
      });
      return { applied: true };
    });
  }

  const reader = (over: Partial<TransferState>) => ({
    getTransferState: jest.fn(async (): Promise<TransferState> => ({
      transferId: 'trf_c',
      disposition: 'SENT',
      amountMinor: AMOUNT,
      currency: 'inr',
      providerStatusRaw: 'paid',
      ...over,
    })),
  });

  const money = async (id: string) => {
    const s = await db!.settlement.findUnique({ where: { id } });
    return { released: s.releasedMinor, transferred: s.transferredMinor, status: s.status };
  };

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

  // ── A: query first, then a late duplicate webhook ────────────────────────────────────

  maybe('A: query says SENT, a duplicate webhook follows, one movement only', async () => {
    const { settlement, attempt, local } = await indeterminateTransfer();

    // Channel 3 resolves the question. It records; it does NOT move money.
    const out = await service.reconcileOne(local, reader({}));
    expect(out.kind).toBe('RESOLVED');
    expect(await money(settlement.id)).toMatchObject({ released: 0, transferred: 0 });

    // Channel 2 arrives and is the thing that applies the movement, exactly once.
    expect(await webhookSaysAccepted(settlement.id, attempt.id, 'trf_c')).toEqual({
      applied: true,
    });
    expect(await money(settlement.id)).toMatchObject({
      released: AMOUNT,
      transferred: AMOUNT,
      status: 'TRANSFERRED',
    });

    // The same webhook again changes nothing.
    expect(await webhookSaysAccepted(settlement.id, attempt.id, 'trf_c')).toEqual({
      applied: false,
    });
    expect(await money(settlement.id)).toMatchObject({ released: AMOUNT, transferred: AMOUNT });
  });

  // ── B: webhook first, then a query that agrees ───────────────────────────────────────

  maybe('B: webhook first, a later query agrees, nothing moves twice', async () => {
    const { settlement, attempt, local } = await indeterminateTransfer();

    expect(await webhookSaysAccepted(settlement.id, attempt.id, 'trf_c')).toEqual({
      applied: true,
    });
    const after = await money(settlement.id);

    // The attempt is settled, so reconciliation has nothing to ask about.
    const out = await service.reconcileOne({ ...local, status: 'SUCCEEDED' }, reader({}));
    expect(out.kind).toBe('AGREES');
    expect(await money(settlement.id)).toEqual(after);
    expect(
      await db!.settlementReconciliationFinding.count({ where: { transferAttemptId: attempt.id } }),
    ).toBe(0);
  });

  // ── C: local says sent, the provider contradicts it ──────────────────────────────────

  maybe('C: a contradiction opens a finding and repairs nothing', async () => {
    const { settlement, attempt, local } = await indeterminateTransfer();
    await webhookSaysAccepted(settlement.id, attempt.id, 'trf_c');
    const before = await money(settlement.id);

    const out = await service.reconcileOne(
      { ...local, status: 'SUCCEEDED' },
      reader({ disposition: 'FAILED' }),
    );
    /*
      Our ledger says the organizer has it; the provider says it never went. No worker may choose
      between them, and rewriting either side would destroy the evidence they disagreed.
    */
    expect(out).toMatchObject({ kind: 'FINDING', finding: 'PROVIDER_CONTRADICTS_LOCAL' });
    expect(await money(settlement.id)).toEqual(before);
    const [f] = await db!.settlementReconciliationFinding.findMany({
      where: { transferAttemptId: attempt.id },
    });
    expect(f).toMatchObject({ status: 'OPEN', kind: 'PROVIDER_CONTRADICTS_LOCAL' });
  });

  // ── D: query cannot say, a webhook later proves it ───────────────────────────────────

  maybe('D: uncertainty survives a query and is settled by a webhook, once', async () => {
    const { settlement, attempt, local } = await indeterminateTransfer();

    const out = await service.reconcileOne(local, reader({ disposition: 'UNKNOWN' }));
    expect(out).toMatchObject({ kind: 'FINDING', finding: 'STILL_UNRESOLVED' });
    expect(await money(settlement.id)).toMatchObject({ released: 0, transferred: 0 });

    expect(await webhookSaysAccepted(settlement.id, attempt.id, 'trf_c')).toEqual({
      applied: true,
    });
    expect(await money(settlement.id)).toMatchObject({ released: AMOUNT, transferred: AMOUNT });

    // Asking again now that it is settled does not reopen anything or move anything.
    const again = await service.reconcileOne({ ...local, status: 'SUCCEEDED' }, reader({}));
    expect(again.kind).toBe('AGREES');
    expect(await money(settlement.id)).toMatchObject({ released: AMOUNT, transferred: AMOUNT });
  });

  // ── E: a manual disposition, then contradicting evidence ─────────────────────────────

  maybe('E: new evidence after a manual disposition opens a NEW finding', async () => {
    /*
      A person closed the exception. Later evidence disagrees. The disposition is history and
      stays exactly as recorded - but the disagreement is not hidden, it becomes its own open
      finding for somebody to look at.
    */
    const { settlement, attempt, local } = await indeterminateTransfer();
    await service.reconcileOne(local, reader({ disposition: 'NOT_FOUND' }));
    const [open] = await db!.settlementReconciliationFinding.findMany({
      where: { transferAttemptId: attempt.id },
    });

    await service.resolveFinding({ id: 'ops-1' }, open.id, {
      resolution: 'CANNOT_ESTABLISH',
      note: 'Nothing in the dashboard either way after chasing for two weeks.',
    });

    await webhookSaysAccepted(settlement.id, attempt.id, 'trf_c');
    const afterWebhook = await money(settlement.id);

    const out = await service.reconcileOne(
      { ...local, status: 'SUCCEEDED' },
      reader({ disposition: 'FAILED' }),
    );
    expect(out).toMatchObject({ kind: 'FINDING', finding: 'PROVIDER_CONTRADICTS_LOCAL' });

    const all = await db!.settlementReconciliationFinding.findMany({
      where: { transferAttemptId: attempt.id },
      orderBy: { kind: 'asc' },
    });
    const byKind = Object.fromEntries(
      all.map((f: { kind: string; status: string }) => [f.kind, f.status]),
    );
    // The old disposition survives untouched; the new disagreement is open beside it.
    expect(byKind.PROVIDER_HAS_NO_RECORD).toBe('RESOLVED');
    expect(byKind.PROVIDER_CONTRADICTS_LOCAL).toBe('OPEN');
    const resolvedRow = all.find((f: { kind: string }) => f.kind === 'PROVIDER_HAS_NO_RECORD');
    expect(resolvedRow.resolutionNote).toMatch(/two weeks/);
    // And none of it moved money.
    expect(await money(settlement.id)).toEqual(afterWebhook);
  });

  // ── repeated observation never doubles anything ──────────────────────────────────────

  maybe('repeating every channel changes nothing after the first time', async () => {
    const { settlement, attempt, local } = await indeterminateTransfer();

    await service.reconcileOne(local, reader({ disposition: 'UNKNOWN' }));
    await service.reconcileOne(local, reader({ disposition: 'UNKNOWN' }));
    await service.reconcileOne(local, reader({ disposition: 'UNKNOWN' }));
    await webhookSaysAccepted(settlement.id, attempt.id, 'trf_c');
    await webhookSaysAccepted(settlement.id, attempt.id, 'trf_c');
    await webhookSaysAccepted(settlement.id, attempt.id, 'trf_c');

    expect(await money(settlement.id)).toMatchObject({
      released: AMOUNT,
      transferred: AMOUNT,
    });
    const findings = await db!.settlementReconciliationFinding.findMany({
      where: { transferAttemptId: attempt.id },
    });
    // Three observations of one problem is one problem.
    expect(findings).toHaveLength(1);
    expect(findings[0].observationCount).toBe(3);
  });
});
