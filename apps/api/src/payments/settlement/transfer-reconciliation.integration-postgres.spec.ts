import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TransferReconciliationService } from './transfer-reconciliation.service';
import type { LocalTransferFacts } from './transfer-reconciliation';
import type { TransferState } from '../provider/payment-provider.interface';

/**
 * integration-real-postgres — the lifecycle of a durable financial disagreement.
 *
 * ── WHAT THIS IS FOR ───────────────────────────────────────────────────────────────────
 * A disagreement about money has to survive a restart and stay findable until somebody deals
 * with it. That is a claim about rows, not about functions, so it is proven against a real
 * database: the finding is written, it is still there when read back by a fresh client, a
 * second pass does not multiply it, and resolving it does not erase the evidence that it
 * happened.
 *
 * The provider is a controlled double. It proves what WE do with an answer, never what any
 * provider would say.
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

/** Its own country; see docs/guides/TEST-ISOLATION.md. */
const COUNTRY = 'Reconcileland';

describe('integration-real-postgres: reconciliation findings', () => {
  const url = loadDatabaseUrl();
  let db: Client | null = null;
  let service: TransferReconciliationService;
  let available = false;
  let orgId = '';
  let seq = 0;
  const audited: Array<Record<string, unknown>> = [];

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
      data: { name: `Recon ${stamp}`, slug: `recon-${stamp}`, status: 'APPROVED' },
    });
    orgId = org.id;
    service = new TransferReconciliationService(
      db as never,
      {
        record: async (e: unknown) => {
          audited.push(e as Record<string, unknown>);
        },
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

  const guard = () => available;

  /** An attempt whose outcome was never established, in the shape `release()` writes. */
  async function unknownAttempt(amountMinor = 50_000) {
    seq += 1;
    const venue = await db!.venue.create({
      data: { organizationId: orgId, name: `RV${seq}`, city: 'Recontown', country: COUNTRY },
    });
    const event = await db!.event.create({
      data: {
        organizationId: orgId,
        venueId: venue.id,
        title: `Recon ${seq}`,
        slug: `recon-${Date.now()}-${seq}`,
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
        grossSalesMinor: amountMinor,
      },
    });
    const attempt = await db!.settlementTransferAttempt.create({
      data: {
        settlementId: settlement.id,
        requestedMinor: amountMinor,
        currency: 'inr',
        provider: 'stripe',
        idempotencyKey: `settlement_${settlement.id}_0`,
        status: 'UNKNOWN',
        lastError: 'socket hang up',
      },
    });
    const local: LocalTransferFacts = {
      attemptId: attempt.id,
      settlementId: settlement.id,
      organizationId: orgId,
      status: 'UNKNOWN',
      requestedMinor: amountMinor,
      currency: 'inr',
      providerTransferId: null,
      idempotencyKey: attempt.idempotencyKey,
      destinationAccountId: null,
    };
    return { settlement, attempt, local };
  }

  const reader = (state: Partial<TransferState>) => ({
    getTransferState: jest.fn(async (): Promise<TransferState> => ({
      transferId: 'trf_x',
      disposition: 'SENT',
      amountMinor: 50_000,
      currency: 'inr',
      providerStatusRaw: 'processed',
      ...state,
    })),
  });

  const findingsFor = (attemptId: string) =>
    db!.settlementReconciliationFinding.findMany({ where: { transferAttemptId: attemptId } });

  const maybe = (name: string, fn: () => Promise<void>, timeout = 60_000) =>
    it(
      name,
      async () => {
        if (!guard()) {
          console.warn(`SKIPPED (no database): ${name}`);
          return;
        }
        await fn();
      },
      timeout,
    );

  maybe('writes a disagreement that survives a new client', async () => {
    const { attempt, local } = await unknownAttempt();
    await service.reconcileOne(local, reader({ amountMinor: 49_000 }));

    // Read back through a SEPARATE client: durability, not a cache.
    const fresh = new PrismaClient({ datasources: { db: { url } } });
    try {
      const rows = await fresh.settlementReconciliationFinding.findMany({
        where: { transferAttemptId: attempt.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: 'AMOUNT_DISAGREES',
        status: 'OPEN',
        localAmountMinor: 50_000,
        providerAmountMinor: 49_000,
        localCurrency: 'inr',
        observationCount: 1,
      });
      expect(rows[0].detail).toMatch(/50000.*49000/);
    } finally {
      await fresh.$disconnect();
    }
  });

  maybe('does not multiply one disagreement across repeated passes', async () => {
    /*
      Reconciliation is meant to run repeatedly. Opening a new row each pass would bury a queue
      of real problems under copies of one.
    */
    const { attempt, local } = await unknownAttempt();
    const r = reader({ amountMinor: 49_000 });
    await service.reconcileOne(local, r);
    await service.reconcileOne(local, r);
    await service.reconcileOne(local, r);

    const rows = await findingsFor(attempt.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].observationCount).toBe(3);
  });

  maybe('never moves the discovery time, so an old problem cannot look new', async () => {
    const { attempt, local } = await unknownAttempt();
    const r = reader({ amountMinor: 49_000 });
    await service.reconcileOne(local, r);
    const first = (await findingsFor(attempt.id))[0];

    await new Promise((resolve) => setTimeout(resolve, 25));
    await service.reconcileOne(local, r);
    const again = (await findingsFor(attempt.id))[0];

    expect(again.discoveredAt.getTime()).toBe(first.discoveredAt.getTime());
    expect(again.lastSeenAt.getTime()).toBeGreaterThan(first.lastSeenAt.getTime() - 1);
  });

  maybe('keeps separate kinds apart on the same attempt', async () => {
    // Two different things can be wrong at once, and one must not overwrite the other.
    const { attempt, local } = await unknownAttempt();
    await service.reconcileOne(local, reader({ amountMinor: 49_000 }));
    await service.reconcileOne(local, reader({ disposition: 'NOT_FOUND' }));

    const kinds = (await findingsFor(attempt.id)).map((f: { kind: string }) => f.kind).sort();
    expect(kinds).toEqual(['AMOUNT_DISAGREES', 'PROVIDER_HAS_NO_RECORD']);
  });

  maybe('resolves without erasing that the disagreement happened', async () => {
    /*
      The row IS the evidence. Deleting it on resolution would leave nothing to show anyone ever
      had to look into this, which is the opposite of an audit trail.
    */
    const { attempt, local } = await unknownAttempt();
    await service.reconcileOne(local, reader({ disposition: 'PENDING' }));
    expect((await findingsFor(attempt.id))[0].status).toBe('OPEN');

    const out = await service.reconcileOne(local, reader({ disposition: 'SENT' }));
    expect(out.kind).toBe('RESOLVED');

    const rows = await findingsFor(attempt.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('RESOLVED');
    expect(rows[0].resolvedAt).not.toBeNull();
    // Everything that explained the disagreement is still readable.
    expect(rows[0].kind).toBe('STILL_UNRESOLVED');
    expect(rows[0].localAmountMinor).toBe(50_000);
  });

  maybe('records that a provider cannot be asked at all', async () => {
    const { attempt, local } = await unknownAttempt();
    await service.reconcileOne(local, null);

    const rows = await findingsFor(attempt.id);
    expect(rows[0]).toMatchObject({ kind: 'CANNOT_BE_ASKED', providerDisposition: null });
  });

  maybe('changes NOTHING about the money, whatever it concludes', async () => {
    /*
      THE PROPERTY THAT MATTERS MOST. Reconciliation observes. Every money column on the
      settlement and the attempt must read exactly as it did before, including on a RESOLVED
      pass where it would be most tempting to "just catch the ledger up".
    */
    const { settlement, attempt, local } = await unknownAttempt();
    const before = {
      s: await db!.settlement.findUnique({ where: { id: settlement.id } }),
      a: await db!.settlementTransferAttempt.findUnique({ where: { id: attempt.id } }),
    };

    await service.reconcileOne(local, reader({ disposition: 'NOT_FOUND' }));
    await service.reconcileOne(local, reader({ amountMinor: 1 }));
    await service.reconcileOne(local, reader({ disposition: 'SENT' }));

    const after = {
      s: await db!.settlement.findUnique({ where: { id: settlement.id } }),
      a: await db!.settlementTransferAttempt.findUnique({ where: { id: attempt.id } }),
    };

    expect(after.s.releasedMinor).toBe(before.s.releasedMinor);
    expect(after.s.transferredMinor).toBe(before.s.transferredMinor);
    expect(after.s.payableMinor).toBe(before.s.payableMinor);
    expect(after.s.status).toBe(before.s.status);
    // The attempt is evidence too: reconciliation does not promote UNKNOWN to anything.
    expect(after.a.status).toBe('UNKNOWN');
    expect(after.a.requestedMinor).toBe(before.a.requestedMinor);
    expect(after.a.providerTransferId).toBe(before.a.providerTransferId);
  });

  // ── manual disposition: a person decides, and nothing moves ───────────────────────

  const operator = { id: 'ops-1' };

  maybe('records who decided, why, and on what evidence', async () => {
    const { attempt, local } = await unknownAttempt();
    await service.reconcileOne(local, reader({ disposition: 'NOT_FOUND' }));
    const [open] = await findingsFor(attempt.id);

    const out = await service.resolveFinding(operator, open.id, {
      resolution: 'PROVIDER_CONFIRMED_SENT',
      note: 'Dashboard shows the payout against this linked account.',
      evidenceRef: 'trf_seen_by_a_person',
    });
    expect(out.resolved).toBe(true);

    const [row] = await findingsFor(attempt.id);
    expect(row).toMatchObject({
      status: 'RESOLVED',
      resolvedByUserId: 'ops-1',
      resolution: 'PROVIDER_CONFIRMED_SENT',
      resolutionEvidenceRef: 'trf_seen_by_a_person',
    });
    expect(row.resolvedAt).not.toBeNull();
    // The disagreement itself is still fully readable.
    expect(row.kind).toBe('PROVIDER_HAS_NO_RECORD');
    expect(row.localAmountMinor).toBe(50_000);
    expect(audited.some((a) => a.action === 'SETTLEMENT_FINDING_RESOLVED')).toBe(true);
  });

  maybe('refuses a provider claim that cites nothing', async () => {
    const { attempt, local } = await unknownAttempt();
    await service.reconcileOne(local, reader({ disposition: 'NOT_FOUND' }));
    const [open] = await findingsFor(attempt.id);

    const out = await service.resolveFinding(operator, open.id, {
      resolution: 'PROVIDER_CONFIRMED_SENT',
      note: 'I am fairly sure this one went through.',
    });
    expect(out.resolved).toBe(false);
    // Still open: a refused disposition must not half-close anything.
    expect((await findingsFor(attempt.id))[0].status).toBe('OPEN');
  });

  maybe('resolving MOVES NO MONEY, whatever the disposition says', async () => {
    /*
      THE BOUNDARY THAT MATTERS. "An authorized person dispositioned this exception" is not
      "change the ledger until it looks correct". Even PROVIDER_CONFIRMED_SENT - the disposition
      that asserts the organizer has the money - leaves every money column exactly as it was.
    */
    const { settlement, attempt, local } = await unknownAttempt();
    await service.reconcileOne(local, reader({ disposition: 'NOT_FOUND' }));
    const [open] = await findingsFor(attempt.id);

    const sBefore = await db!.settlement.findUnique({ where: { id: settlement.id } });
    const aBefore = await db!.settlementTransferAttempt.findUnique({ where: { id: attempt.id } });

    await service.resolveFinding(operator, open.id, {
      resolution: 'PROVIDER_CONFIRMED_SENT',
      note: 'Dashboard shows the payout against this linked account.',
      evidenceRef: 'trf_x',
    });

    const sAfter = await db!.settlement.findUnique({ where: { id: settlement.id } });
    const aAfter = await db!.settlementTransferAttempt.findUnique({ where: { id: attempt.id } });
    expect(sAfter.releasedMinor).toBe(sBefore.releasedMinor);
    expect(sAfter.transferredMinor).toBe(sBefore.transferredMinor);
    expect(sAfter.payableMinor).toBe(sBefore.payableMinor);
    expect(sAfter.status).toBe(sBefore.status);
    // The attempt is evidence too: a disposition does not promote UNKNOWN to anything.
    expect(aAfter).toEqual(aBefore);
  });

  maybe('cannot be resolved twice, so two operators do not overwrite each other', async () => {
    const { attempt, local } = await unknownAttempt();
    await service.reconcileOne(local, reader({ disposition: 'NOT_FOUND' }));
    const [open] = await findingsFor(attempt.id);

    const first = await service.resolveFinding(operator, open.id, {
      resolution: 'CANNOT_ESTABLISH',
      note: 'No record either way after fourteen days of chasing.',
    });
    const second = await service.resolveFinding({ id: 'ops-2' }, open.id, {
      resolution: 'SETTLED_OUTSIDE_PLATFORM',
      note: 'Paid by bank transfer, see ticket 44.',
    });
    expect(first.resolved).toBe(true);
    expect(second.resolved).toBe(false);

    const [row] = await findingsFor(attempt.id);
    expect(row.resolvedByUserId).toBe('ops-1');
    expect(row.resolution).toBe('CANNOT_ESTABLISH');
  });

  // ── the single source of truth for "somebody must look" ──────────────────────

  maybe('counts OPEN findings, and stops counting once resolved', async () => {
    /*
      This replaces `reconciliationMismatch`, which was hardcoded false and could never be
      anything else. One durable record now answers "does this need attention", and a resolved
      finding stops answering yes while its row stays as evidence.
    */
    const { settlement, attempt, local } = await unknownAttempt();
    expect((await service.openFindingCounts([settlement.id])).get(settlement.id)).toBeUndefined();

    await service.reconcileOne(local, reader({ disposition: 'NOT_FOUND' }));
    expect((await service.openFindingCounts([settlement.id])).get(settlement.id)).toBe(1);

    // Seen again is still ONE problem, not two.
    await service.reconcileOne(local, reader({ disposition: 'NOT_FOUND' }));
    expect((await service.openFindingCounts([settlement.id])).get(settlement.id)).toBe(1);

    const [open] = await findingsFor(attempt.id);
    await service.resolveFinding(operator, open.id, {
      resolution: 'CANNOT_ESTABLISH',
      note: 'No record either way after fourteen days of chasing.',
    });
    expect((await service.openFindingCounts([settlement.id])).get(settlement.id)).toBeUndefined();
    // The evidence survives the queue.
    expect(
      await db!.settlementReconciliationFinding.count({ where: { settlementId: settlement.id } }),
    ).toBe(1);
  });

  maybe('a NEW contradiction after a resolution opens its own finding', async () => {
    // Resolving one question does not silence a different one discovered later.
    const { settlement, attempt, local } = await unknownAttempt();
    await service.reconcileOne(local, reader({ disposition: 'NOT_FOUND' }));
    const [open] = await findingsFor(attempt.id);
    await service.resolveFinding(operator, open.id, {
      resolution: 'CANNOT_ESTABLISH',
      note: 'No record either way after fourteen days of chasing.',
    });

    await service.reconcileOne(local, reader({ amountMinor: 49_000 }));

    expect((await service.openFindingCounts([settlement.id])).get(settlement.id)).toBe(1);
    const kinds = (await findingsFor(attempt.id))
      .map((f: { kind: string; status: string }) => `${f.kind}:${f.status}`)
      .sort();
    expect(kinds).toEqual(['AMOUNT_DISAGREES:OPEN', 'PROVIDER_HAS_NO_RECORD:RESOLVED']);
  });

  maybe('a recheck observes and records, and cannot ask anybody anything yet', async () => {
    /*
      The operator-triggered path. No adapter implements a status query, so the honest result is
      CANNOT_BE_ASKED - recorded as a finding rather than dressed up as a look.
    */
    const { attempt } = await unknownAttempt();
    const out = await service.recheckAttempt(attempt.id);
    expect(out.checked).toBe(true);
    expect(out.checked === true && out.outcome).toMatchObject({
      kind: 'FINDING',
      finding: 'CANNOT_BE_ASKED',
    });
    expect((await findingsFor(attempt.id))[0].kind).toBe('CANNOT_BE_ASKED');
  });

  maybe('a recheck of nothing is a refusal, not a crash', async () => {
    const out = await service.recheckAttempt('att_does_not_exist');
    expect(out.checked).toBe(false);
  });

  maybe('finds unresolved attempts oldest first, and bounds the page', async () => {
    const a = await unknownAttempt(11_000);
    const b = await unknownAttempt(12_000);
    const rows = await service.unresolvedAttempts(100, orgId);
    const ids = rows.map((r: { id: string }) => r.id);
    expect(ids).toContain(a.attempt.id);
    expect(ids).toContain(b.attempt.id);
    expect(ids.indexOf(a.attempt.id)).toBeLessThan(ids.indexOf(b.attempt.id));

    // A caller cannot ask for an unbounded page.
    expect((await service.unresolvedAttempts(10_000, orgId)).length).toBeLessThanOrEqual(200);
  });
});
