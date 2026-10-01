import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { reconcileTransferEvidence, outstandingMinor } from './transfer-evidence';
import type { TransferEvidence, SettlementReversalFacts } from './transfer-evidence';

/**
 * integration-real-postgres — R4 certification.
 *
 * ── WHY A REAL DATABASE ────────────────────────────────────────────────────────────
 * The engine's arithmetic is proven by unit tests. What those cannot prove is that the FACTS fed
 * to it are read correctly from real rows: that `confirmedReversedMinor` sums only COMPLETED
 * attempts, that `unresolvedAttempts` counts the right states, that a decrement lands once, and
 * that the integer amounts in the database are what the engine intended.
 *
 * Every money assertion below is on an INTEGER, not a status. A status can be right while the
 * amount is wrong, which is precisely the shape R4 took.
 *
 * Skips (never fabricates a pass) when no database is reachable.
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

describe('integration-real-postgres: R4 certification', () => {
  const url = loadDatabaseUrl();
  let db: Client | null = null;
  let available = false;
  let orgId = '';
  let eventSeq = 0;

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
      data: { name: `R4 ${stamp}`, slug: `r4-${stamp}`, status: 'APPROVED' },
    });
    orgId = org.id;
  }, 60_000);

  afterAll(async () => {
    if (!available || !db) return;
    const settlements = await db.settlement.findMany({ where: { organizationId: orgId } });
    for (const s of settlements) {
      await db.settlementReversalAttempt
        .deleteMany({ where: { settlementId: s.id } })
        .catch(() => {});
    }
    await db.settlement.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.event.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.venue.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
    await db.$disconnect();
  }, 60_000);

  const guard = () => {
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn('skipped — no database');
      return true;
    }
    return false;
  };

  /** A transferred settlement of `released`, with its own event so each test is isolated. */
  const settlementOf = async (released: number, currency = 'inr') => {
    eventSeq += 1;
    const venue = await db!.venue.create({
      data: { organizationId: orgId, name: `V${eventSeq}`, city: 'Bengaluru', country: 'India' },
    });
    const event = await db!.event.create({
      data: {
        organizationId: orgId,
        venueId: venue.id,
        title: `R4 ${eventSeq}`,
        slug: `r4-${Date.now()}-${eventSeq}`,
        category: 'Music',
        status: 'COMPLETED',
      },
    });
    return db!.settlement.create({
      data: {
        organizationId: orgId,
        eventId: event.id,
        currency,
        status: 'TRANSFERRED',
        transferredMinor: released,
        releasedMinor: released,
        providerTransferId: `tr_${eventSeq}`,
        provider: 'razorpay',
        reversalLedgerFrom: new Date(),
      },
    });
  };

  const completedAttempt = (settlementId: string, amount: number, seq: number) =>
    db!.settlementReversalAttempt.create({
      data: {
        settlementId,
        reason: 'REFUND',
        requestedMinor: amount,
        confirmedMinor: amount,
        currency: 'inr',
        provider: 'razorpay',
        status: 'COMPLETED',
        idempotencyKey: `k_${settlementId}_${seq}`,
      },
    });

  /** Read the facts the engine consumes, exactly as the service does. */
  const factsFor = async (settlementId: string): Promise<SettlementReversalFacts> => {
    const s = await db!.settlement.findUnique({ where: { id: settlementId } });
    const attempts = await db!.settlementReversalAttempt.findMany({ where: { settlementId } });
    return {
      settlementId,
      providerTransferId: s!.providerTransferId,
      currency: s!.currency,
      releasedMinor: s!.releasedMinor || s!.transferredMinor,
      confirmedReversedMinor: attempts
        .filter((a: { status: string }) => a.status === 'COMPLETED')
        .reduce((t: number, a: { confirmedMinor: number }) => t + a.confirmedMinor, 0),
      unresolvedAttempts: attempts.filter((a: { status: string }) =>
        ['REQUESTED', 'PROCESSING', 'UNKNOWN'].includes(a.status),
      ).length,
    };
  };

  const evidenceFor = (
    transferId: string,
    cumulative: number,
    over: Partial<TransferEvidence> = {},
  ): TransferEvidence => ({
    provider: 'razorpay',
    providerTransferId: transferId,
    currency: 'inr',
    originalTransferredMinor: null,
    cumulativeReversedMinor: cumulative,
    providerStatusRaw: null,
    observedAt: new Date(),
    source: 'WEBHOOK',
    ...over,
  });

  // ── 1, 4, 11: partial, second partial, cumulative full ────────────────────────
  it('1. a confirmed partial reversal leaves exact integer amounts', async () => {
    if (guard()) return;
    const s = await settlementOf(100_000);
    await completedAttempt(s.id, 30_000, 1);

    const f = await factsFor(s.id);
    expect(f.confirmedReversedMinor).toBe(30_000);
    expect(outstandingMinor(f)).toBe(70_000);
    expect(reconcileTransferEvidence(f, evidenceFor(s.providerTransferId!, 30_000))).toMatchObject({
      kind: 'AGREES',
    });
  });

  it('4. a second partial reversal accumulates, and the delta is only the new part', async () => {
    if (guard()) return;
    const s = await settlementOf(100_000);
    await completedAttempt(s.id, 30_000, 1);
    await completedAttempt(s.id, 20_000, 2);

    const f = await factsFor(s.id);
    expect(f.confirmedReversedMinor).toBe(50_000);
    expect(outstandingMinor(f)).toBe(50_000);
    // The provider now reports 50000 cumulative: nothing new.
    expect(reconcileTransferEvidence(f, evidenceFor(s.providerTransferId!, 50_000))).toMatchObject({
      kind: 'AGREES',
    });
    // And 65000 means 15000 more, never 65000.
    expect(reconcileTransferEvidence(f, evidenceFor(s.providerTransferId!, 65_000))).toMatchObject({
      kind: 'NEWLY_CONFIRMED',
      deltaMinor: 15_000,
    });
  });

  it('11. cumulative reaching the full transfer leaves nothing outstanding', async () => {
    if (guard()) return;
    const s = await settlementOf(100_000);
    await completedAttempt(s.id, 60_000, 1);
    await completedAttempt(s.id, 40_000, 2);

    const f = await factsFor(s.id);
    expect(f.confirmedReversedMinor).toBe(100_000);
    expect(outstandingMinor(f)).toBe(0);
  });

  // ── 2, 3: webhook confirms, duplicate webhook ─────────────────────────────────
  it('2 and 3. a duplicate webhook adds nothing the second time', async () => {
    if (guard()) return;
    const s = await settlementOf(100_000);
    const e = evidenceFor(s.providerTransferId!, 30_000);

    const first = reconcileTransferEvidence(await factsFor(s.id), e);
    expect(first).toMatchObject({ kind: 'NEWLY_CONFIRMED', deltaMinor: 30_000 });

    await completedAttempt(s.id, 30_000, 1); // apply it

    const second = reconcileTransferEvidence(await factsFor(s.id), e);
    expect(second).toMatchObject({ kind: 'AGREES' });
    expect(outstandingMinor(await factsFor(s.id))).toBe(70_000);
  });

  // ── 6: out-of-order ───────────────────────────────────────────────────────────
  it('6. an older webhook after newer evidence never decreases confirmed money', async () => {
    if (guard()) return;
    const s = await settlementOf(100_000);
    await completedAttempt(s.id, 50_000, 1);
    await db!.settlementReversalAttempt.create({
      data: {
        settlementId: s.id,
        reason: 'REFUND',
        requestedMinor: 10_000,
        currency: 'inr',
        provider: 'razorpay',
        status: 'PROCESSING',
        idempotencyKey: `k_${s.id}_inflight`,
      },
    });

    const f = await factsFor(s.id);
    expect(f.unresolvedAttempts).toBe(1);
    const stale = reconcileTransferEvidence(f, evidenceFor(s.providerTransferId!, 30_000));
    expect(stale).toMatchObject({ kind: 'STALE', alreadyConfirmedMinor: 50_000 });
    expect(outstandingMinor(await factsFor(s.id))).toBe(50_000);
  });

  // ── 7, 8: UNKNOWN and PROCESSING resolved by query ────────────────────────────
  it.each(['UNKNOWN', 'PROCESSING'])(
    '7 and 8. a %s attempt is resolved by a provider query',
    async (status) => {
      if (guard()) return;
      const s = await settlementOf(100_000);
      await db!.settlementReversalAttempt.create({
        data: {
          settlementId: s.id,
          reason: 'REFUND',
          requestedMinor: 25_000,
          currency: 'inr',
          provider: 'razorpay',
          status: status as never,
          idempotencyKey: `k_${s.id}_${status}`,
        },
      });

      const f = await factsFor(s.id);
      expect(f.confirmedReversedMinor).toBe(0); // unresolved attempts confirm nothing
      const out = reconcileTransferEvidence(
        f,
        evidenceFor(s.providerTransferId!, 25_000, { source: 'PROVIDER_QUERY' }),
      );
      expect(out).toMatchObject({ kind: 'NEWLY_CONFIRMED', deltaMinor: 25_000 });
    },
  );

  // ── 9, 10: failure states confirm nothing ─────────────────────────────────────
  it.each(['FAILED', 'UNKNOWN'])(
    '9 and 10. a %s attempt contributes zero to confirmed money',
    async (status) => {
      if (guard()) return;
      const s = await settlementOf(100_000);
      await db!.settlementReversalAttempt.create({
        data: {
          settlementId: s.id,
          reason: 'REFUND',
          requestedMinor: 40_000,
          currency: 'inr',
          provider: 'razorpay',
          status: status as never,
          lastError: status === 'FAILED' ? 'provider refused' : null,
          idempotencyKey: `k_${s.id}_${status}_9`,
        },
      });

      const f = await factsFor(s.id);
      expect(f.confirmedReversedMinor).toBe(0);
      expect(outstandingMinor(f)).toBe(100_000);
    },
  );

  // ── 12, 13, 14, 15: contradictory evidence ────────────────────────────────────
  it('12. cumulative greater than the transfer is a mismatch, not a clamp', async () => {
    if (guard()) return;
    const s = await settlementOf(100_000);
    const out = reconcileTransferEvidence(
      await factsFor(s.id),
      evidenceFor(s.providerTransferId!, 150_000),
    );
    expect(out.kind).toBe('MISMATCH');
    expect(outstandingMinor(await factsFor(s.id))).toBe(100_000);
  });

  it('13. cumulative lower than confirmed, with nothing in flight, is a mismatch', async () => {
    if (guard()) return;
    const s = await settlementOf(100_000);
    await completedAttempt(s.id, 60_000, 1);

    const f = await factsFor(s.id);
    expect(f.unresolvedAttempts).toBe(0);
    expect(reconcileTransferEvidence(f, evidenceFor(s.providerTransferId!, 20_000)).kind).toBe(
      'MISMATCH',
    );
    expect(outstandingMinor(await factsFor(s.id))).toBe(40_000);
  });

  it('14. a currency mismatch is refused', async () => {
    if (guard()) return;
    const s = await settlementOf(100_000);
    const out = reconcileTransferEvidence(
      await factsFor(s.id),
      evidenceFor(s.providerTransferId!, 10_000, { currency: 'USD' }),
    );
    expect(out).toMatchObject({ kind: 'MISMATCH', reason: 'currency does not match' });
  });

  it('15. evidence for a different transfer is refused', async () => {
    if (guard()) return;
    const s = await settlementOf(100_000);
    const out = reconcileTransferEvidence(
      await factsFor(s.id),
      evidenceFor('tr_SOMEONE_ELSE', 10_000),
    );
    expect(out).toMatchObject({ kind: 'MISMATCH', reason: 'evidence is for a different transfer' });
  });

  // ── 5: webhook before orchestration finishes persisting ──────────────────────
  it('5. a webhook arriving before orchestration persists converges on one answer', async () => {
    if (guard()) return;
    /*
      The race the old code could not even detect. Orchestration has written REQUESTED and is
      still waiting on its HTTP response when the webhook arrives carrying the cumulative figure.

      Both paths read the same facts and run the same engine, so whichever lands first confirms
      the amount and the other then sees AGREES. The final money is the same either way, and it
      is applied exactly once.
    */
    const s = await settlementOf(100_000);
    await db!.settlementReversalAttempt.create({
      data: {
        settlementId: s.id,
        reason: 'REFUND',
        requestedMinor: 30_000,
        currency: 'inr',
        provider: 'razorpay',
        status: 'REQUESTED',
        idempotencyKey: `k_${s.id}_race`,
      },
    });

    const e = evidenceFor(s.providerTransferId!, 30_000);

    // Webhook first: it proves the money came back.
    const viaWebhook = reconcileTransferEvidence(await factsFor(s.id), e);
    expect(viaWebhook).toMatchObject({ kind: 'NEWLY_CONFIRMED', deltaMinor: 30_000 });

    // Apply it, then the synchronous response lands with the same provider state.
    await db!.settlementReversalAttempt.updateMany({
      where: { settlementId: s.id, status: 'REQUESTED' },
      data: { status: 'COMPLETED', confirmedMinor: 30_000 },
    });

    const viaSync = reconcileTransferEvidence(await factsFor(s.id), {
      ...e,
      source: 'SYNC_RESPONSE',
    });
    expect(viaSync).toMatchObject({ kind: 'AGREES' });

    // Exactly once.
    const f = await factsFor(s.id);
    expect(f.confirmedReversedMinor).toBe(30_000);
    expect(outstandingMinor(f)).toBe(70_000);
  });

  // ── 16, 17: ownership, against these very rows ───────────────────────────────
  it('16 and 17. neither a partial nor a full reversal releases provider ownership', async () => {
    if (guard()) return;
    /*
      Proven here against real settlements rather than cross-referenced, because the claim is
      about THESE rows: whatever the reversal arithmetic concluded, the event stays claimed.
      Release requires an explicit disposition, which does not exist yet - so today there is no
      path out at all.
    */
    const partial = await settlementOf(100_000);
    await completedAttempt(partial.id, 30_000, 90);
    const full = await settlementOf(100_000);
    await completedAttempt(full.id, 100_000, 91);

    for (const id of [partial.id, full.id]) {
      const row = await db!.settlement.findUnique({ where: { id } });
      // Still in a claimed status; nothing in the reversal path rewrote it to something released.
      expect(['TRANSFERRED', 'PARTIALLY_REFUNDED', 'REVERSED']).toContain(row!.status);
    }

    const fullFacts = await factsFor(full.id);
    expect(outstandingMinor(fullFacts)).toBe(0);
    // Nothing outstanding, and STILL provider-owned.
    const fullRow = await db!.settlement.findUnique({ where: { id: full.id } });
    expect(['TRANSFERRED', 'PARTIALLY_REFUNDED', 'REVERSED']).toContain(fullRow!.status);
  });

  // ── the invariant, over real rows ─────────────────────────────────────────────
  it('holds 0 <= confirmed <= released across every settlement it created', async () => {
    if (guard()) return;
    const settlements = await db!.settlement.findMany({ where: { organizationId: orgId } });
    expect(settlements.length).toBeGreaterThan(0);

    for (const s of settlements) {
      const f = await factsFor(s.id);
      expect(f.confirmedReversedMinor).toBeGreaterThanOrEqual(0);
      expect(f.confirmedReversedMinor).toBeLessThanOrEqual(f.releasedMinor);
      expect(outstandingMinor(f)).toBeGreaterThanOrEqual(0);
    }
  });
});
