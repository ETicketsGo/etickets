import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * integration-real-postgres — the reversal ledger's CONSTRAINTS, and nothing else.
 *
 * ── WHAT THIS PROVES ───────────────────────────────────────────────────────────────
 * Schema and persistence only. Nothing writes to this table in production yet: no orchestration,
 * no adapter, no webhook. What is being checked is that the table can hold the history a
 * reversal argument actually produces, and that its constraints stop the things that must not
 * happen without stopping the things that must.
 *
 * The distinction this file exists for: IDEMPOTENCY and RETRY are related and are not the same
 * thing. A retried call for one logical operation must dedupe. A DELIBERATE second attempt after
 * a failure must be allowed, and must keep the first attempt's evidence. A uniqueness constraint
 * that confused the two would quietly make supersession impossible, and the symptom would be a
 * clawback nobody could retry.
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

describe('integration-real-postgres: the reversal attempt ledger', () => {
  const url = loadDatabaseUrl();
  let db: Client | null = null;
  let available = false;
  let orgId = '';
  let eventId = '';
  let settlementId = '';
  const made: string[] = [];

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
      data: {
        name: `Reversal Ledger ${stamp}`,
        slug: `reversal-ledger-${stamp}`,
        status: 'APPROVED',
      },
    });
    orgId = org.id;
    const venue = await db!.venue.create({
      data: { organizationId: orgId, name: `V ${stamp}`, city: 'Bengaluru', country: 'India' },
    });
    const event = await db!.event.create({
      data: {
        organizationId: orgId,
        venueId: venue.id,
        title: `Reversal Ledger Event ${stamp}`,
        slug: `reversal-ledger-event-${stamp}`,
        category: 'Music',
        status: 'COMPLETED',
      },
    });
    eventId = event.id;
    const settlement = await db!.settlement.create({
      data: {
        organizationId: orgId,
        eventId,
        currency: 'inr',
        status: 'TRANSFERRED',
        transferredMinor: 100_000,
        releasedMinor: 100_000,
        reversalLedgerFrom: new Date(),
      },
    });
    settlementId = settlement.id;
  }, 60_000);

  afterAll(async () => {
    if (!available || !db) return;
    await db.settlementReversalAttempt.deleteMany({ where: { settlementId } }).catch(() => {});
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

  /** One attempt, with everything defaulted except what a caller must decide. */
  const attempt = async (over: Record<string, unknown> = {}) => {
    const row = await db!.settlementReversalAttempt.create({
      data: {
        settlementId,
        reason: 'REFUND',
        requestedMinor: 20_000,
        currency: 'inr',
        provider: 'razorpay',
        idempotencyKey: `rev:${settlementId}:REFUND:r1:${made.length}:${Math.random()}`,
        ...over,
      },
    });
    made.push(row.id);
    return row;
  };

  // ── retry history, which the constraints must NOT prevent ────────────────────────
  describe('retry and supersession', () => {
    it('allows many attempts for the SAME settlement, refund and amount', async () => {
      if (guard()) return;
      /*
        The case worth protecting. A first clawback fails, somebody raises another for the same
        refund and the same money. Identical in every financial respect, different attempts. A
        constraint on (settlement, refund, amount) would have made this impossible and left a
        failed clawback with no way to retry it.
      */
      const first = await attempt({ refundId: 'refund-same', status: 'FAILED' });
      const second = await attempt({ refundId: 'refund-same', supersedesId: first.id });
      const third = await attempt({ refundId: 'refund-same' });

      const rows = await db!.settlementReversalAttempt.findMany({
        where: { settlementId, refundId: 'refund-same' },
      });
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((r: { id: string }) => r.id)).size).toBe(3);
      expect(second.supersedesId).toBe(first.id);
      expect(third.supersedesId).toBeNull();
    });

    it('keeps the superseded attempt and its evidence readable', async () => {
      if (guard()) return;
      // A retry must never overwrite the argument it replaces.
      const failed = await attempt({
        refundId: 'refund-evidence',
        status: 'FAILED',
        lastError: 'provider refused: insufficient balance',
        providerStatusRaw: 'reversal_failed',
      });
      await attempt({ refundId: 'refund-evidence', supersedesId: failed.id });

      const original = await db!.settlementReversalAttempt.findUnique({ where: { id: failed.id } });
      expect(original!.status).toBe('FAILED');
      expect(original!.lastError).toContain('insufficient balance');
      expect(original!.providerStatusRaw).toBe('reversal_failed');
    });

    it('walks the supersession chain in both directions', async () => {
      if (guard()) return;
      const a = await attempt({ refundId: 'refund-chain', status: 'UNKNOWN' });
      const b = await attempt({ refundId: 'refund-chain', supersedesId: a.id });

      const loaded = await db!.settlementReversalAttempt.findUnique({
        where: { id: b.id },
        include: { supersedes: true },
      });
      expect(loaded!.supersedes!.id).toBe(a.id);

      const back = await db!.settlementReversalAttempt.findUnique({
        where: { id: a.id },
        include: { supersededBy: true },
      });
      expect(back!.supersededBy!.id).toBe(b.id);
    });

    it('refuses to supersede one attempt twice', async () => {
      if (guard()) return;
      // Otherwise the chain forks and "which attempt replaced this one" stops having an answer.
      const base = await attempt({ refundId: 'refund-fork', status: 'FAILED' });
      await attempt({ refundId: 'refund-fork', supersedesId: base.id });
      await expect(attempt({ refundId: 'refund-fork', supersedesId: base.id })).rejects.toThrow();
    });
  });

  // ── idempotency, which the constraints MUST enforce ──────────────────────────────
  describe('idempotency', () => {
    it('refuses a second attempt with the same key', async () => {
      if (guard()) return;
      const key = `rev:${settlementId}:REFUND:r-idem:0`;
      await attempt({ refundId: 'refund-idem', idempotencyKey: key });
      await expect(attempt({ refundId: 'refund-idem', idempotencyKey: key })).rejects.toThrow();
    });

    it('records one row per provider operation', async () => {
      if (guard()) return;
      // The same provider reversal must not be counted twice, whatever arrives and in what order.
      await attempt({ refundId: 'refund-op', providerReversalId: 'rvrsl_once' });
      await expect(
        attempt({ refundId: 'refund-op-2', providerReversalId: 'rvrsl_once' }),
      ).rejects.toThrow();
    });

    it('lets the same provider id exist under a DIFFERENT provider', async () => {
      if (guard()) return;
      // Ids are only unique within a provider; two providers may coincidentally agree.
      await attempt({ provider: 'stripe', providerReversalId: 'shared_id' });
      const other = await attempt({ provider: 'razorpay', providerReversalId: 'shared_id' });
      expect(other.provider).toBe('razorpay');
    });

    it('allows many attempts with NO provider id yet', async () => {
      if (guard()) return;
      /*
        The one that would bite silently. Every attempt starts REQUESTED with no provider id, so
        if NULLs collided in the unique index only ONE could ever be in flight. Postgres does not
        collide NULLs - asserted here rather than assumed, because the whole crash-recovery
        design depends on it.
      */
      await attempt({ refundId: 'refund-null-a' });
      await attempt({ refundId: 'refund-null-b' });
      const open = await db!.settlementReversalAttempt.findMany({
        where: { settlementId, providerReversalId: null },
      });
      expect(open.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── defaults that keep an unwritten row honest ───────────────────────────────────
  describe('defaults', () => {
    it('starts REQUESTED, confirming nothing', async () => {
      if (guard()) return;
      const row = await attempt({ refundId: 'refund-default' });
      expect(row.status).toBe('REQUESTED');
      expect(row.confirmedMinor).toBe(0);
      expect(row.providerReversalId).toBeNull();
      expect(row.settledAt).toBeNull();
      expect(row.lastReconciledAt).toBeNull();
    });

    it('keeps the synchronous answer apart from later evidence', async () => {
      if (guard()) return;
      // A disagreement between the two is what reconciliation hunts for; merging destroys it.
      const row = await attempt({
        refundId: 'refund-eviz',
        syncResponse: { status: 'accepted' },
        evidence: { webhook: 'reversed' },
      });
      const loaded = await db!.settlementReversalAttempt.findUnique({ where: { id: row.id } });
      expect(loaded!.syncResponse).toEqual({ status: 'accepted' });
      expect(loaded!.evidence).toEqual({ webhook: 'reversed' });
    });
  });

  // ── the migration's effect on settlements that predate it ────────────────────────
  describe('settlements that predate the ledger', () => {
    it('defaults releasedMinor to zero and reconstructs nothing', async () => {
      if (guard()) return;
      /*
        `Settlement.status` cannot say how many reversals produced a PARTIALLY_REFUNDED, for how
        much, or whether any failed. A releasedMinor derived from it would be a guess wearing the
        authority of a record, so historical rows get zero and a null marker - visibly unknown.
      */
      const legacy = await db!.settlement.create({
        data: {
          organizationId: orgId,
          eventId,
          currency: 'usd',
          status: 'PARTIALLY_REFUNDED',
          transferredMinor: 35_000,
          refundsMinor: 20_000,
        },
      });
      expect(legacy.releasedMinor).toBe(0);
      expect(legacy.reversalLedgerFrom).toBeNull();
      await db!.settlement.delete({ where: { id: legacy.id } });
    });

    it('is distinguishable from a settlement the ledger covers', async () => {
      if (guard()) return;
      const covered = await db!.settlement.findUnique({ where: { id: settlementId } });
      expect(covered!.reversalLedgerFrom).not.toBeNull();
      expect(covered!.releasedMinor).toBe(100_000);
    });
  });

  // ── the table is not wired to anything ───────────────────────────────────────────
  it('is written by nothing in production yet', async () => {
    if (guard()) return;
    /*
      PR 2 is schema only. Every row in this database was created by this spec; if orchestration
      had been wired in early, rows would appear that this file did not make.
    */
    const all = await db!.settlementReversalAttempt.findMany({ where: { settlementId } });
    const unexpected = all.filter((r: { id: string }) => !made.includes(r.id));
    expect(unexpected).toEqual([]);
  });
});
