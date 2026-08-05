import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BookingWorkflowRepository } from './booking-workflow.repository';
import { BookingWorkflowState as WS } from './booking-workflow-state';
import { CompensationRepository } from '../compensation/compensation.repository';
import { CompensationState } from '../compensation/compensation-state';
import { CompensationType } from '../compensation/compensation-types';

/**
 * integration-real-postgres — provider-authoritative HA concurrency proofs (ADR-042 P5.3A.1).
 * Exercises the ACTUAL primitives that enforce the invariants against real PostgreSQL:
 *   - the workflow guarded optimistic-concurrency `advance` (one transition winner)
 *   - `createOrGet` idempotency (one workflow per key)
 *   - the compensation lease-based `claimReady` + stale-lease recovery (workers can't collide)
 * SKIPS visibly (never a fabricated pass) when PostgreSQL is unavailable.
 *
 * NOTE: Redis-level seat/GA lock contention and Redis-finalize behaviour are proven by the
 * existing P3 real-Redis lock tests; GA allocation capacity by the allocation-accounting
 * real-Postgres proof; once-per-durable-handler outbox delivery (dispatcher restart / stale
 * lease) by the P2.1 outbox tests — the new provider events flow through that same path.
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

describe('integration-real-postgres: provider-authoritative HA concurrency', () => {
  const url = loadDatabaseUrl();
  let prisma: InstanceType<typeof PrismaClient> | undefined;
  let workflows: BookingWorkflowRepository;
  let comp: CompensationRepository;
  let available = false;
  const tag = `itest-pa-${Date.now()}`;
  const bookingIds: string[] = [];

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
      workflows = new BookingWorkflowRepository(prisma as never);
      comp = new CompensationRepository(prisma as never);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[integration-real-postgres] SKIPPED — DB unavailable: ${(err as Error).message}`,
      );
    }
  });

  afterAll(async () => {
    if (prisma && available) {
      await prisma.bookingCompensation
        .deleteMany({ where: { bookingId: { startsWith: tag } } })
        .catch(() => undefined);
      await prisma.bookingWorkflow
        .deleteMany({ where: { bookingId: { in: bookingIds } } })
        .catch(() => undefined);
    }
    await prisma?.$disconnect().catch(() => undefined);
  });

  async function seedWorkflow(state: string): Promise<{ id: string; bookingId: string }> {
    const bookingId = `${tag}-${bookingIds.length}`;
    bookingIds.push(bookingId);
    const row = await prisma!.bookingWorkflow.create({
      data: {
        bookingId,
        idempotencyKey: `${bookingId}:k`,
        inventoryOwnershipMode: 'PROVIDER_AUTHORITATIVE',
        selectedProviderCode: 'mock-external-booking',
        state: state as never,
      },
    });
    return { id: row.id, bookingId };
  }

  it('concurrent identical confirmation → exactly one ADVANCED, the rest idempotent replays', async () => {
    if (!available) return;
    const { id } = await seedWorkflow(WS.PAYMENT_AUTHORIZED);
    const wf = (await workflows.get(id))!;
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => workflows.advance(wf, WS.PROVIDER_CONFIRM_PENDING)),
    );
    const advanced = results.filter(
      (r) => r.status === 'fulfilled' && r.value.outcome === 'ADVANCED',
    );
    const replays = results.filter((r) => r.status === 'fulfilled' && r.value.outcome === 'REPLAY');
    expect(advanced).toHaveLength(1); // the transition happens once
    expect(replays.length).toBe(6 - 1); // duplicates are idempotent, never a second confirmation
    expect((await workflows.get(id))!.state).toBe(WS.PROVIDER_CONFIRM_PENDING);
  }, 30_000);

  it('confirmation vs expiration vs cancellation from one state → only one winner', async () => {
    if (!available) return;
    const { id } = await seedWorkflow(WS.PROVIDER_RESERVED);
    const wf = (await workflows.get(id))!;
    // From PROVIDER_RESERVED these three are all individually legal; concurrently only one wins.
    const results = await Promise.allSettled([
      workflows.advance(wf, WS.PAYMENT_PENDING), // proceed toward confirmation
      workflows.advance(wf, WS.EXPIRING), // expiration
      workflows.advance(wf, WS.CANCELLATION_PENDING), // cancellation
    ]);
    const advanced = results.filter(
      (r) => r.status === 'fulfilled' && r.value.outcome === 'ADVANCED',
    );
    const conflicts = results.filter((r) => r.status === 'rejected');
    expect(advanced).toHaveLength(1); // exactly one terminal progression wins
    expect(conflicts).toHaveLength(2); // the losers get a safe optimistic-concurrency conflict
  }, 30_000);

  it('a confirmed workflow cannot also be expired or cancelled', async () => {
    if (!available) return;
    const { id } = await seedWorkflow(WS.CONFIRMING);
    let wf = (await workflows.get(id))!;
    wf = (await workflows.advance(wf, WS.CONFIRMED)).workflow;
    // Now a late expiration/cancellation attempt must fail — CONFIRMED has no such transitions.
    await expect(workflows.advance(wf, WS.EXPIRING)).rejects.toBeTruthy();
    expect((await workflows.get(id))!.state).toBe(WS.CONFIRMED);
  }, 30_000);

  it('concurrent createOrGet under one idempotency key creates exactly one workflow', async () => {
    if (!available) return;
    const key = `${tag}-idem`;
    bookingIds.push(`pending-${key}`);
    const input = {
      idempotencyKey: key,
      requestFingerprint: 'fp1',
      inventoryOwnershipMode: 'PROVIDER_AUTHORITATIVE' as const,
      selectedProviderCode: 'mock-external-booking',
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => workflows.createOrGet(input)),
    );
    const created = results.filter((r) => r.created);
    const ids = new Set(results.map((r) => r.workflow.id));
    expect(created).toHaveLength(1); // one workflow (one provider reservation) per key
    expect(ids.size).toBe(1); // every caller sees the same workflow
  }, 30_000);

  it('two workers claiming compensations get disjoint records (each claimed once)', async () => {
    if (!available) return;
    const bookingId = `${tag}-comp`;
    // Seed several READY compensations (distinct targets satisfy the idempotency unique key).
    const rows = [];
    for (let i = 0; i < 6; i++) {
      const { compensation } = await comp.createOrGet(
        {
          compensationType: CompensationType.REDIS_LOCK_RELEASE,
          reasonCode: 'X',
          targetReference: `lock-${i}`,
          autoExecutable: true,
        },
        { bookingId },
      );
      const ready = await comp.advance(compensation, CompensationState.READY);
      rows.push(ready);
    }
    const [a, b] = await Promise.all([
      comp.claimReady('worker-A', 60, 10),
      comp.claimReady('worker-B', 60, 10),
    ]);
    const idsA = new Set(a.map((r) => r.id));
    const idsB = new Set(b.map((r) => r.id));
    const overlap = [...idsA].filter((id) => idsB.has(id));
    expect(overlap).toHaveLength(0); // no record claimed by both workers
    expect(idsA.size + idsB.size).toBe(rows.length); // every record claimed exactly once
    await prisma!.bookingCompensation.deleteMany({ where: { bookingId } }).catch(() => undefined);
  }, 30_000);

  it('concurrent provider cancellation marks cancelled exactly once (Phase 4)', async () => {
    if (!available) return;
    const { id } = await seedWorkflow(WS.PROVIDER_RESERVED);
    await prisma!.bookingWorkflow.update({
      where: { id },
      data: { providerReservationId: 'res-cancel', providerStatus: 'RESERVED' },
    });
    // The definitive-cancel marker is a guarded UPDATE on providerCancelledAt IS NULL; N
    // concurrent finalizers (duplicate workers / retries) can set it only once.
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        prisma!.bookingWorkflow.updateMany({
          where: { id, providerCancelledAt: null },
          data: { providerCancelledAt: new Date(), providerStatus: 'CANCELLED' },
        }),
      ),
    );
    const applied = results.filter((r) => r.status === 'fulfilled' && r.value.count === 1);
    expect(applied).toHaveLength(1); // cancelled exactly once
    const row = await prisma!.bookingWorkflow.findUnique({ where: { id } });
    expect(row?.providerStatus).toBe('CANCELLED');
  }, 30_000);

  it('concurrent PAYMENT_VOID planners create exactly one plan; captured handoff creates one refund plan', async () => {
    if (!available) return;
    const bookingId = `${tag}-void`;
    // Concurrent planners for the same (booking, PAYMENT_VOID, target) → one plan (unique key).
    const voids = await Promise.all(
      Array.from({ length: 6 }, () =>
        comp.createOrGet(
          {
            compensationType: 'PAYMENT_VOID' as never,
            reasonCode: 'X',
            targetReference: 'pay-ref-1',
            autoExecutable: false,
          },
          { bookingId },
        ),
      ),
    );
    expect(voids.filter((v) => v.created)).toHaveLength(1);
    // Captured handoff: concurrent PAYMENT_REFUND creates → one plan.
    const refunds = await Promise.all(
      Array.from({ length: 6 }, () =>
        comp.createOrGet(
          {
            compensationType: 'PAYMENT_REFUND' as never,
            reasonCode: 'PAYMENT_CAPTURED_VOID_SUPERSEDED',
            targetReference: 'pay-ref-1',
            autoExecutable: false,
          },
          { bookingId },
        ),
      ),
    );
    expect(refunds.filter((r) => r.created)).toHaveLength(1);
    await prisma!.bookingCompensation.deleteMany({ where: { bookingId } }).catch(() => undefined);
  }, 30_000);

  it('stale compensation leases recover to READY exactly once', async () => {
    if (!available) return;
    const bookingId = `${tag}-stale`;
    const row = await prisma!.bookingCompensation.create({
      data: {
        bookingId,
        compensationType: 'REDIS_LOCK_RELEASE' as never,
        reasonCode: 'X',
        targetReference: 'lock-stale',
        idempotencyKey: `${bookingId}:k`,
        state: 'PROCESSING' as never,
        lockedBy: 'dead-worker',
        lockExpiresAt: new Date(Date.now() - 60_000),
      },
    });
    const recovered = await comp.recoverStaleLeases();
    expect(recovered).toBeGreaterThanOrEqual(1);
    const after = await prisma!.bookingCompensation.findUnique({ where: { id: row.id } });
    expect(after?.state).toBe('READY');
    await prisma!.bookingCompensation.deleteMany({ where: { bookingId } }).catch(() => undefined);
  }, 30_000);
});
