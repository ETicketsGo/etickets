import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SettlementService } from './settlement.service';

/**
 * integration-real-postgres — what `release()` actually PERSISTS.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────────────────
 * `Settlement.releasedMinor` was read by four call sites and written by none. Every spec that
 * touched it - including the real-Postgres ones - SET it in a fixture, which is a row shape
 * production could never produce. A green suite therefore proved nothing about the field, and the
 * Unified Finance producer was the first reader to notice.
 *
 * So these tests never construct the state they assert on. They drive the REAL
 * `SettlementService.release()` and `applyRefund()` against a REAL database and then read the row
 * back. If the writer stops recording the figure, these fail; a fixture cannot rescue them.
 *
 * ── WHAT IS STUBBED, AND WHY THAT IS NOT PROVIDER EVIDENCE ─────────────────────────────
 * Only the provider adapter, plus audit and notification sinks. The adapter is the process
 * boundary: stubbing it is what lets us observe OUR OWN persistence around a transfer. Nothing
 * here is evidence of how Stripe or Razorpay behaves, and nothing here moves real money - the
 * adapter is named `stripe` precisely so the Razorpay Route gate is never involved.
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

/*
  Its own country. `country: 'India'` appears in 50 spec files and the suite runs in parallel
  against one database; see docs/guides/TEST-ISOLATION.md.
*/
const COUNTRY = 'Writerland';

const actor = { id: 'writer-test-actor' };

describe('integration-real-postgres: what release() persists', () => {
  const url = loadDatabaseUrl();
  let db: Client | null = null;
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
      data: { name: `Writer ${stamp}`, slug: `writer-${stamp}`, status: 'APPROVED' },
    });
    orgId = org.id;
  }, 60_000);

  afterAll(async () => {
    if (!available || !db) return;
    const rows = await db.settlement.findMany({ where: { organizationId: orgId } });
    for (const s of rows) {
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

  /**
   * A settlement in the state the approval flow leaves it: APPROVED, nothing transferred, and
   * `releasedMinor` at its schema default. Deliberately NOT given a released figure.
   */
  async function approvedSettlement(grossSalesMinor: number, over: Record<string, unknown> = {}) {
    seq += 1;
    const venue = await db!.venue.create({
      data: { organizationId: orgId, name: `WV${seq}`, city: 'Writertown', country: COUNTRY },
    });
    const event = await db!.event.create({
      data: {
        organizationId: orgId,
        venueId: venue.id,
        title: `Writer ${seq}`,
        slug: `writer-${Date.now()}-${seq}`,
        category: 'Music',
        status: 'COMPLETED',
      },
    });
    return db!.settlement.create({
      data: {
        organizationId: orgId,
        eventId: event.id,
        provider: 'stripe',
        currency: 'usd',
        status: 'APPROVED',
        grossSalesMinor,
        connectedAccountId: `acct_writer_${seq}`,
        ...over,
      },
    });
  }

  /**
   * The real service, with a real Prisma client. `createTransfer` records the calls it receives
   * so the idempotency-key assertions read what the service actually sent.
   */
  function makeService(opts: {
    createTransfer?: jest.Mock;
    reverseTransfer?: jest.Mock;
    reserveBps?: number;
    /**
     * Whether this adapter can prove a replayed transfer would be deduplicated.
     *
     * Defaults to TRUE so the tests above keep exercising the transfer path. An adapter that
     * declares false - the Razorpay adapter does, because it discards the idempotency identity -
     * is refused an automatic replay, which is what the gate tests below assert.
     */
    supportsIdempotentTransfer?: boolean;
    /** The platform-wide payout switch. Off is the real default; tests opt in. */
    payoutExecutionEnabled?: boolean;
  }) {
    const calls: Array<Record<string, unknown>> = [];
    const createTransfer =
      opts.createTransfer ??
      jest.fn(async (req: Record<string, unknown>) => {
        calls.push(req);
        return { transferId: `tr_${calls.length}_${Date.now()}`, raw: {} };
      });
    const provider = {
      name: 'stripe',
      createTransfer,
      reverseTransfer: opts.reverseTransfer,
      capabilities: {
        supportsIdempotentTransfer: opts.supportsIdempotentTransfer ?? true,
        supportsTransferStatusQuery: false,
      },
    };
    const service = new SettlementService(
      db as never,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
      {
        send: jest.fn().mockResolvedValue(undefined),
        sendCritical: jest.fn().mockResolvedValue(undefined),
        fanOutCritical: jest.fn().mockResolvedValue(0),
      } as never,
      {
        // Payout execution is OFF by default; a release test opts in deliberately.
        get: jest.fn((key: string) =>
          key === 'PAYOUT_EXECUTION_ENABLED'
            ? (opts.payoutExecutionEnabled ?? true)
            : (opts.reserveBps ?? 0),
        ),
      } as never,
      { get: jest.fn().mockReturnValue(provider) } as never,
    );
    return { service, createTransfer, calls };
  }

  const read = (id: string) => db!.settlement.findUnique({ where: { id } });

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

  // ── 1. the successful release ────────────────────────────────────────────────────────

  maybe('records the amount it sent, not just that it sent something', async () => {
    const s = await approvedSettlement(90_000);
    const { service } = makeService({});

    await service.release(actor as never, s.id, 'writer test');

    const row = await read(s.id);
    expect(row.status).toBe('TRANSFERRED');
    /*
      The assertion the old fixtures could not make. Before the fix this was 0 on a row whose
      status said TRANSFERRED - a settlement that had demonstrably paid out 90,000 while the
      field meant to record it stayed at its default.
    */
    expect(row.releasedMinor).toBe(90_000);
    expect(row.transferredMinor).toBe(90_000);
  });

  maybe('leaves the schema invariant true with no reversals', async () => {
    const s = await approvedSettlement(45_500);
    const { service } = makeService({});

    await service.release(actor as never, s.id, 'writer test');

    const row = await read(s.id);
    // transferredMinor == releasedMinor - Sum(confirmed reversals), and there are none.
    expect(row.transferredMinor).toBe(row.releasedMinor - 0);
  });

  maybe('records only the payable amount when a reserve is withheld', async () => {
    // 10% withheld, so the figure recorded must be what LEFT, not what was owed.
    const s = await approvedSettlement(100_000);
    const { service } = makeService({ reserveBps: 1_000 });

    await service.release(actor as never, s.id, 'writer test');

    const row = await read(s.id);
    expect(row.reserveMinor).toBe(10_000);
    expect(row.releasedMinor).toBe(90_000);
    expect(row.releasedMinor).toBe(row.payableMinor);
    // Not the entitlement. A reserve is money that never moved.
    expect(row.releasedMinor).not.toBe(100_000);
  });

  // ── 2. nothing moved means nothing recorded ──────────────────────────────────────────

  maybe('records no movement when the provider refuses', async () => {
    const s = await approvedSettlement(70_000);
    const { service } = makeService({
      createTransfer: jest.fn(async () => {
        throw new Error('provider refused');
      }),
    });

    await expect(service.release(actor as never, s.id, 'writer test')).rejects.toThrow();

    const row = await read(s.id);
    expect(row.status).toBe('FAILED');
    // Both figures must stay untouched: no money left, so no money is claimed to have left.
    expect(row.releasedMinor).toBe(0);
    expect(row.transferredMinor).toBe(0);
  });

  maybe('records no movement when the payable amount is zero', async () => {
    // Refunds have consumed the entire entitlement, so the release is a no-op that still closes.
    const s = await approvedSettlement(50_000, { refundsMinor: 50_000 });
    const { service, createTransfer } = makeService({});

    await service.release(actor as never, s.id, 'writer test');

    const row = await read(s.id);
    expect(row.status).toBe('TRANSFERRED');
    expect(row.payableMinor).toBe(0);
    // Closing a settlement is not the same as paying one.
    expect(row.releasedMinor).toBe(0);
    expect(createTransfer).not.toHaveBeenCalled();
  });

  // ── 3. retry and idempotency ─────────────────────────────────────────────────────────

  maybe('does not record twice when release is called again', async () => {
    const s = await approvedSettlement(60_000);
    const { service, createTransfer } = makeService({});

    await service.release(actor as never, s.id, 'first');
    await service.release(actor as never, s.id, 'second');

    const row = await read(s.id);
    // The second call returns on the already-TRANSFERRED guard, so the figure cannot double.
    expect(row.releasedMinor).toBe(60_000);
    expect(createTransfer).toHaveBeenCalledTimes(1);
  });

  maybe('retries a lost write under the SAME idempotency key', async () => {
    /*
      The dangerous window: the provider accepted the transfer and our own persistence never
      happened. The key is derived from the PRIOR transferredMinor, which only advances once that
      persistence commits - so the retry presents the same key, the provider deduplicates, and the
      organizer is not paid twice. This test proves the key is stable across that window.
    */
    const s = await approvedSettlement(80_000);
    const keys: unknown[] = [];
    let failFirst = true;
    const createTransfer = jest.fn(async (req: Record<string, unknown>) => {
      keys.push(req.idempotencyKey);
      if (failFirst) {
        failFirst = false;
        throw new Error('accepted at the provider, answer lost in transit');
      }
      return { transferId: 'tr_retry', raw: {} };
    });
    const { service } = makeService({ createTransfer });

    await expect(service.release(actor as never, s.id, 'attempt 1')).rejects.toThrow();
    const afterFailure = await read(s.id);
    expect(afterFailure.status).toBe('FAILED');
    expect(afterFailure.releasedMinor).toBe(0);

    // FAILED is releasable precisely so this recovery is possible.
    await service.release(actor as never, s.id, 'attempt 2');

    const row = await read(s.id);
    expect(row.status).toBe('TRANSFERRED');
    expect(row.releasedMinor).toBe(80_000);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  maybe('accumulates across an incremental second release', async () => {
    /*
      `releasedMinor` increments rather than assigns. A settlement whose entitlement grows after
      a first transfer releases only the difference, and the cumulative figure must reflect both.
    */
    const s = await approvedSettlement(40_000);
    const { service } = makeService({});

    await service.release(actor as never, s.id, 'first');
    // More sales arrive, and the settlement is re-approved for the remainder.
    await db!.settlement.update({
      where: { id: s.id },
      data: { grossSalesMinor: 65_000, status: 'APPROVED' },
    });
    await service.release(actor as never, s.id, 'second');

    const row = await read(s.id);
    // 40,000 then the 25,000 difference - cumulative, and still equal to current holdings.
    expect(row.releasedMinor).toBe(65_000);
    expect(row.transferredMinor).toBe(65_000);
  });

  // ── 4. reversal: the invariant, and the money the old fallback refused ────────────────

  const confirmedReversal = () =>
    jest.fn(async (req: Record<string, unknown>) => ({
      kind: 'CONFIRMED' as const,
      confirmedMinor: req.amountMinor as number,
      reversalId: `rvsl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      raw: {},
    }));

  maybe('keeps the invariant true after a confirmed reversal', async () => {
    const s = await approvedSettlement(100_000);
    const { service } = makeService({ reverseTransfer: confirmedReversal() });

    await service.release(actor as never, s.id, 'writer test');
    await service.applyRefund(s.eventId, 'usd', 30_000);

    const row = await read(s.id);
    // releasedMinor never decrements; transferredMinor does.
    expect(row.releasedMinor).toBe(100_000);
    expect(row.transferredMinor).toBe(70_000);
    expect(row.transferredMinor).toBe(row.releasedMinor - 30_000);
  });

  maybe('still claws back money on a SECOND reversal', async () => {
    /*
      ── THE MONEY DEFECT THIS CHANGE FIXES ───────────────────────────────────────────────
      The clamp allows `released - Sum(confirmed)`. While nothing wrote `releasedMinor`, both
      readers fell through to `transferredMinor`, which confirmed reversals have ALREADY
      decremented - so the confirmed total was subtracted twice and the clamp reached zero.

      Concretely, at 100,000 released and 70,000 already reversed, the second reversal computed
      30,000 - 70,000 and was refused. `refundsMinor` had already been incremented, so the ledger
      said the money came back while it was still with the organizer, and no attempt row recorded
      the refusal. This is the test that could not pass before.
    */
    const s = await approvedSettlement(100_000);
    const reverseTransfer = confirmedReversal();
    const { service } = makeService({ reverseTransfer });

    await service.release(actor as never, s.id, 'writer test');
    await service.applyRefund(s.eventId, 'usd', 70_000);
    await service.applyRefund(s.eventId, 'usd', 30_000);

    const row = await read(s.id);
    expect(reverseTransfer).toHaveBeenCalledTimes(2);
    expect(row.transferredMinor).toBe(0);
    expect(row.releasedMinor).toBe(100_000);

    const attempts = await db!.settlementReversalAttempt.findMany({
      where: { settlementId: s.id },
    });
    expect(attempts).toHaveLength(2);
    const confirmed = attempts.reduce(
      (t: number, a: { confirmedMinor: number }) => t + a.confirmedMinor,
      0,
    );
    expect(confirmed).toBe(100_000);
    expect(row.transferredMinor).toBe(row.releasedMinor - confirmed);
  });

  maybe('refuses to reverse more than was ever released', async () => {
    // The clamp must still clamp. A wider `releasedMinor` must not become a licence to over-claw.
    const s = await approvedSettlement(50_000);
    const reverseTransfer = confirmedReversal();
    const { service } = makeService({ reverseTransfer });

    await service.release(actor as never, s.id, 'writer test');
    await service.applyRefund(s.eventId, 'usd', 80_000);

    const row = await read(s.id);
    expect(row.transferredMinor).toBe(0);
    // Asked for 80,000; only 50,000 ever left, so only 50,000 could come back.
    expect(reverseTransfer).toHaveBeenCalledTimes(1);
    expect(reverseTransfer.mock.calls[0][0].amountMinor).toBe(50_000);
  });

  maybe('does not undo a reversal that lands DURING an incremental release', async () => {
    /*
      ── A RACE, MADE DETERMINISTIC ───────────────────────────────────────────────────────
      The atomic claim stops two releases overlapping, but `reverseIfTransferred` gates on
      `providerTransferId`, not on status - so a refund webhook can confirm a reversal while a
      second, incremental release is in flight at the provider.

      The provider call is where that window really is, so the reversal is driven from inside
      the stub: by the time the release persists, `transferredMinor` has already been decremented
      underneath it. An absolute write computed from the pre-transfer snapshot silently restored
      the money that had just been clawed back.
    */
    const s = await approvedSettlement(40_000);
    const reverseTransfer = confirmedReversal();
    let service!: ReturnType<typeof makeService>['service'];

    const createTransfer = jest.fn(async () => {
      // Exactly the window: the transfer is away, our row has not been written yet.
      await service.applyRefund(s.eventId, 'usd', 10_000);
      return { transferId: `tr_race_${Date.now()}`, raw: {} };
    });

    ({ service } = makeService({ reverseTransfer }));
    await service.release(actor as never, s.id, 'first');

    // Entitlement grows; the second release moves only the difference.
    await db!.settlement.update({
      where: { id: s.id },
      data: { grossSalesMinor: 70_000, status: 'APPROVED' },
    });
    ({ service } = makeService({ createTransfer, reverseTransfer }));
    await service.release(actor as never, s.id, 'second');

    const row = await read(s.id);
    const attempts = await db!.settlementReversalAttempt.findMany({
      where: { settlementId: s.id },
    });
    const confirmed = attempts
      .filter((a: { status: string }) => a.status === 'COMPLETED')
      .reduce((t: number, a: { confirmedMinor: number }) => t + a.confirmedMinor, 0);

    expect(createTransfer).toHaveBeenCalledTimes(1);
    expect(confirmed).toBe(10_000);
    /*
      40,000 out, then a further 30,000: the payable is computed from the snapshot BEFORE the
      refund lands, so the second transfer legitimately sends 70,000 - 40,000. Cumulative OUT
      movement is 70,000 and the claw-back does not reduce it.
    */
    expect(row.releasedMinor).toBe(70_000);
    // The decrement must survive. Without the fix this read 70,000 - the reversal undone.
    expect(row.transferredMinor).toBe(60_000);
    expect(row.transferredMinor).toBe(row.releasedMinor - confirmed);
  });

  // ── 4b. the durable record of having asked a provider to move money ──────────────────

  const attemptsFor = (settlementId: string) =>
    db!.settlementTransferAttempt.findMany({
      where: { settlementId },
      orderBy: { requestedAt: 'asc' },
    });

  maybe('records the attempt BEFORE the provider is called', async () => {
    /*
      The window that had no evidence at all. If the process dies inside `createTransfer` there
      must already be a row saying we asked, or the crash is indistinguishable from never having
      tried. Asserted from INSIDE the provider call, which is exactly that moment.
    */
    const s = await approvedSettlement(42_000);
    let seenDuringCall: Array<{ status: string; requestedMinor: number }> = [];
    const createTransfer = jest.fn(async () => {
      seenDuringCall = await attemptsFor(s.id);
      return { transferId: 'tr_durable', raw: {} };
    });

    await makeService({ createTransfer }).service.release(actor as never, s.id, 'durable');

    expect(seenDuringCall).toHaveLength(1);
    expect(seenDuringCall[0].status).toBe('REQUESTED');
    expect(seenDuringCall[0].requestedMinor).toBe(42_000);
  });

  maybe('marks the attempt SUCCEEDED with the provider reference', async () => {
    const s = await approvedSettlement(42_000);
    await makeService({}).service.release(actor as never, s.id, 'ok');

    const [a] = await attemptsFor(s.id);
    expect(a.status).toBe('SUCCEEDED');
    expect(a.providerTransferId).toBeTruthy();
    expect(a.providerTransferId).toBe((await read(s.id)).providerTransferId);
    expect(a.respondedAt).not.toBeNull();
  });

  maybe('records an ambiguous outcome as UNKNOWN, never FAILED', async () => {
    /*
      THE POINT. A timeout means the provider may have sent the money. The attempt row is where
      that uncertainty lives; writing FAILED there would state something we cannot know.
    */
    const s = await approvedSettlement(42_000);
    const createTransfer = jest.fn(async () => {
      throw new Error('socket hang up');
    });
    await expect(
      makeService({ createTransfer }).service.release(actor as never, s.id, 'timeout'),
    ).rejects.toThrow();

    const [a] = await attemptsFor(s.id);
    expect(a.status).toBe('UNKNOWN');
    expect(a.status).not.toBe('FAILED');
    expect(a.lastError).toMatch(/socket hang up/);
    expect(a.providerTransferId).toBeNull();
    // The settlement keeps its coarse FAILED; the attempt carries the honest state.
    expect((await read(s.id)).status).toBe('FAILED');
  });

  maybe('leaves one attempt per try, under one operation identity', async () => {
    const s = await approvedSettlement(42_000);
    let failFirst = true;
    const createTransfer = jest.fn(async () => {
      if (failFirst) {
        failFirst = false;
        throw new Error('lost');
      }
      return { transferId: 'tr_second', raw: {} };
    });
    const { service } = makeService({ createTransfer, supportsIdempotentTransfer: true });
    await expect(service.release(actor as never, s.id, 'one')).rejects.toThrow();
    await service.release(actor as never, s.id, 'two');

    const all = await attemptsFor(s.id);
    expect(all.map((a: { status: string }) => a.status)).toEqual(['UNKNOWN', 'SUCCEEDED']);
    // Two attempts at ONE operation: the identity is shared on purpose.
    expect(new Set(all.map((a: { idempotencyKey: string }) => a.idempotencyKey)).size).toBe(1);
  });

  maybe('refuses to reuse one identity for a different amount', async () => {
    /*
      ── THE EDGE THIS CLOSES ─────────────────────────────────────────────────────────────
      The key is derived from the settlement and its PRIOR transferred amount, but the amount
      also depends on refunds. A refund landing between a crash and a retry produces the same
      identity carrying a different amount. Stripe rejects that; Razorpay is unverified. Rather
      than depend on either, ETicketsGo refuses to send it.
    */
    const s = await approvedSettlement(60_000);
    const createTransfer = jest.fn(async () => {
      throw new Error('lost in transit');
    });
    await expect(
      makeService({ createTransfer }).service.release(actor as never, s.id, 'one'),
    ).rejects.toThrow();
    expect((await attemptsFor(s.id))[0].requestedMinor).toBe(60_000);

    // A refund arrives while the first attempt's outcome is still unknown.
    await db!.settlement.update({ where: { id: s.id }, data: { refundsMinor: 15_000 } });

    const replay = jest.fn(async () => ({ transferId: 'tr_nope', raw: {} }));
    await expect(
      makeService({ createTransfer: replay, supportsIdempotentTransfer: true }).service.release(
        actor as never,
        s.id,
        'two',
      ),
    ).rejects.toThrow();

    // Refused before anything left the process.
    expect(replay).not.toHaveBeenCalled();
    const row = await read(s.id);
    expect(row.status).toBe('BLOCKED');
    expect(row.blockedReason).toMatch(/different amount/i);
    expect(row.releasedMinor).toBe(0);
    // And no second attempt row was created for an identity we refused to reuse.
    expect(await attemptsFor(s.id)).toHaveLength(1);
  });
  // ── 4c. a refusal is not the same thing as not knowing ─────────────────────────

  maybe('records an authoritative refusal as FAILED, not UNKNOWN', async () => {
    /*
      THE DISTINCTION THE CONTRACT EXISTS FOR. The provider declined BEFORE acting, so nothing
      moved and there is nothing for a reconciliation worker to resolve. Recording UNKNOWN here
      would park a settled question in a queue of real uncertainty and dilute it.
    */
    const s = await approvedSettlement(33_000);
    const createTransfer = jest.fn(async () => ({
      kind: 'REFUSED' as const,
      code: 'account_closed',
      message: 'destination account is closed',
      retryable: false,
      raw: { type: 'StripeInvalidRequestError', code: 'account_closed' },
    }));

    await expect(
      makeService({ createTransfer }).service.release(actor as never, s.id, 'refused'),
    ).rejects.toThrow();

    const [a] = await attemptsFor(s.id);
    expect(a.status).toBe('FAILED');
    expect(a.status).not.toBe('UNKNOWN');
    expect(a.lastError).toMatch(/account_closed/);
    // Nothing moved, and the refusal is kept for whoever reads the row later.
    expect(a.providerTransferId).toBeNull();
    expect(a.syncResponse).toMatchObject({ code: 'account_closed' });
    const row = await read(s.id);
    expect(row.releasedMinor).toBe(0);
    expect(row.transferredMinor).toBe(0);
  });

  maybe('records a reported INDETERMINATE as UNKNOWN, with the cause kept', async () => {
    // The adapter reports it rather than throwing; the honest state and the cause both survive.
    const s = await approvedSettlement(33_000);
    const createTransfer = jest.fn(async () => ({
      kind: 'INDETERMINATE' as const,
      raw: { type: 'StripeConnectionError', message: 'connection reset by peer' },
    }));

    await expect(
      makeService({ createTransfer }).service.release(actor as never, s.id, 'indeterminate'),
    ).rejects.toThrow();

    const [a] = await attemptsFor(s.id);
    expect(a.status).toBe('UNKNOWN');
    expect(a.lastError).toMatch(/connection reset by peer/);
    expect(a.syncResponse).toMatchObject({ type: 'StripeConnectionError' });
  });

  maybe(
    'a refusal leaves the settlement replayable; the provider settled the question',
    async () => {
      /*
      A FAILED attempt means the provider declined without acting, so a later release is an
      ordinary first attempt - not a replay of something that might already have paid. The
      replay gate must not treat it as one, even on an adapter that cannot deduplicate.
    */
      const s = await approvedSettlement(33_000);
      const refuse = jest.fn(async () => ({
        kind: 'REFUSED' as const,
        code: 'rate_limited',
        message: 'slow down',
        retryable: true,
        raw: {},
      }));
      await expect(
        makeService({ createTransfer: refuse, supportsIdempotentTransfer: false }).service.release(
          actor as never,
          s.id,
          'one',
        ),
      ).rejects.toThrow();

      const { service, createTransfer } = makeService({ supportsIdempotentTransfer: false });
      await service.release(actor as never, s.id, 'two');

      expect(createTransfer).toHaveBeenCalledTimes(1);
      const row = await read(s.id);
      expect(row.status).toBe('TRANSFERRED');
      expect(row.releasedMinor).toBe(33_000);
    },
  );

  // ── 4d. the platform-wide payout switch ───────────────────────────────────

  maybe('refuses to send anything while payout execution is switched off', async () => {
    /*
      CONTROLLED LAUNCH. Customers can be buying tickets while no money leaves for organizers,
      and that has to be ONE explicit switch rather than an emergent property of which provider
      happens to be configured. Before this, only Razorpay had a gate - a Stripe settlement could
      be released with nothing but an operator\'s judgement in the way.
    */
    const s = await approvedSettlement(64_000);
    const { service, createTransfer } = makeService({ payoutExecutionEnabled: false });

    await expect(service.release(actor as never, s.id, 'while off')).rejects.toThrow(
      /switched off/i,
    );

    // Nothing was attempted, and nothing about this settlement was changed.
    expect(createTransfer).not.toHaveBeenCalled();
    const row = await read(s.id);
    expect(row.releasedMinor).toBe(0);
    expect(row.transferredMinor).toBe(0);
    /*
      Still APPROVED, deliberately NOT blocked. "Payouts are off" is a fact about the platform,
      not something wrong with this settlement, and marking it BLOCKED would leave a trail of
      payouts that look troubled when they are merely waiting.
    */
    expect(row.status).toBe('APPROVED');
    expect(row.blockedReason).toBeNull();
    // And no attempt row either: nothing was asked of any provider.
    expect(await attemptsFor(s.id)).toHaveLength(0);
  });

  maybe('is OFF when nobody has said otherwise', async () => {
    /*
      THE DEFAULT IS THE WHOLE POINT. A switch that only works when somebody remembers to set it
      is not a control. This harness supplies NO value for the key, which is what an environment
      that has never heard of it looks like.
    */
    const s = await approvedSettlement(64_000);
    const createTransfer = jest.fn(async () => ({
      kind: 'ACCEPTED' as const,
      transferId: 'tr_should_not_happen',
      raw: {},
    }));
    const service = new SettlementService(
      db as never,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
      {
        send: jest.fn().mockResolvedValue(undefined),
        sendCritical: jest.fn().mockResolvedValue(undefined),
        fanOutCritical: jest.fn().mockResolvedValue(0),
      } as never,
      // Answers nothing about any key, the way an unconfigured environment does.
      { get: jest.fn(() => undefined) } as never,
      {
        get: jest.fn().mockReturnValue({
          name: 'stripe',
          createTransfer,
          capabilities: { supportsIdempotentTransfer: true, supportsTransferStatusQuery: false },
        }),
      } as never,
    );

    await expect(service.release(actor as never, s.id, 'unconfigured')).rejects.toThrow(
      /switched off/i,
    );
    expect(createTransfer).not.toHaveBeenCalled();
    expect((await read(s.id)).status).toBe('APPROVED');
  });

  maybe('what the organizer is owed is untouched while payouts are off', async () => {
    // Entitlement keeps accruing and stays visible; only the outbound transfer is refused.
    const s = await approvedSettlement(64_000);
    const before = await read(s.id);
    const { service } = makeService({ payoutExecutionEnabled: false });

    await expect(service.release(actor as never, s.id, 'one')).rejects.toThrow();
    await expect(service.release(actor as never, s.id, 'two')).rejects.toThrow();

    const after = await read(s.id);
    expect(after.grossSalesMinor).toBe(before.grossSalesMinor);
    expect(after.payableMinor).toBe(before.payableMinor);
    expect(after.status).toBe('APPROVED');
  });

  maybe('turning it on later releases normally, with nothing to undo', async () => {
    /*
      The switch is not a state machine. A settlement refused while payouts were off is an
      ordinary APPROVED settlement afterwards - no cleanup, no stuck row, no first attempt that
      has to be reasoned about.
    */
    const s = await approvedSettlement(64_000);
    await expect(
      makeService({ payoutExecutionEnabled: false }).service.release(actor as never, s.id, 'off'),
    ).rejects.toThrow();

    const { service, createTransfer } = makeService({ payoutExecutionEnabled: true });
    await service.release(actor as never, s.id, 'on');

    expect(createTransfer).toHaveBeenCalledTimes(1);
    const row = await read(s.id);
    expect(row.status).toBe('TRANSFERRED');
    expect(row.releasedMinor).toBe(64_000);
  });

  // ── 5. replaying a transfer whose outcome we never learned ───────────────────────────

  maybe('refuses to replay a transfer on a provider that cannot deduplicate', async () => {
    /*
      ── WHY THIS IS THE WORST CASE ───────────────────────────────────────────────────────
      `release()` writes FAILED for every error, including a timeout - so a FAILED settlement
      with no `providerTransferId` is NOT one we know did not pay. The organizer may already
      have the money.

      Replaying that is safe only where a repeated request would be deduplicated. The Razorpay
      adapter declares it cannot, because it discards the idempotency identity before calling
      Razorpay, so the replay must not happen at all - not be attempted and hope.
    */
    const s = await approvedSettlement(55_000);
    const first = jest.fn(async () => {
      throw new Error('timeout - the provider may or may not have sent the money');
    });
    await expect(
      makeService({ createTransfer: first }).service.release(actor as never, s.id, 'attempt 1'),
    ).rejects.toThrow();
    expect((await read(s.id)).status).toBe('FAILED');

    const replay = jest.fn(async () => ({ transferId: 'tr_should_not_happen', raw: {} }));
    const { service } = makeService({
      createTransfer: replay,
      supportsIdempotentTransfer: false,
    });

    await expect(service.release(actor as never, s.id, 'attempt 2')).rejects.toThrow();

    // The money must not have been sent a second time.
    expect(replay).not.toHaveBeenCalled();
    const row = await read(s.id);
    expect(row.releasedMinor).toBe(0);
    expect(row.transferredMinor).toBe(0);
    // And it must be visible to a person rather than silently stuck.
    expect(row.status).toBe('BLOCKED');
    expect(row.blockedReason).toMatch(/outcome is unknown/i);
  });

  maybe('still gates a pre-attempt-table settlement left in FAILED', async () => {
    /*
      Settlements released before the attempt table existed have no rows to reason about, so the
      only evidence is the coarse one: FAILED with no transfer id. That could be a refusal or a
      timeout, and nothing records which - so it stays blocked on a provider that cannot
      deduplicate. The fallback is conservative precisely because the evidence is poor.
    */
    const s = await approvedSettlement(27_000, { status: 'FAILED' });
    const replay = jest.fn(async () => ({ transferId: 'tr_no', raw: {} }));
    const { service } = makeService({
      createTransfer: replay,
      supportsIdempotentTransfer: false,
    });

    await expect(service.release(actor as never, s.id, 'legacy replay')).rejects.toThrow();

    expect(replay).not.toHaveBeenCalled();
    expect((await read(s.id)).status).toBe('BLOCKED');
  });

  maybe('still replays on a provider that CAN deduplicate', async () => {
    // The gate must not block legitimate recovery, which is the whole reason FAILED is releasable.
    const s = await approvedSettlement(55_000);
    let failFirst = true;
    const createTransfer = jest.fn(async () => {
      if (failFirst) {
        failFirst = false;
        throw new Error('answer lost in transit');
      }
      return { transferId: 'tr_dedup', raw: {} };
    });
    const { service } = makeService({ createTransfer, supportsIdempotentTransfer: true });

    await expect(service.release(actor as never, s.id, 'attempt 1')).rejects.toThrow();
    await service.release(actor as never, s.id, 'attempt 2');

    const row = await read(s.id);
    expect(row.status).toBe('TRANSFERRED');
    expect(row.releasedMinor).toBe(55_000);
    expect(createTransfer).toHaveBeenCalledTimes(2);
  });

  maybe('does not gate a FIRST attempt on a provider that cannot deduplicate', async () => {
    /*
      Nothing has been sent, so there is nothing to double. Gating this would stop every Razorpay
      payout rather than only the unsafe replay.
    */
    const s = await approvedSettlement(30_000);
    const { service, createTransfer } = makeService({ supportsIdempotentTransfer: false });

    await service.release(actor as never, s.id, 'first and only');

    expect(createTransfer).toHaveBeenCalledTimes(1);
    const row = await read(s.id);
    expect(row.status).toBe('TRANSFERRED');
    expect(row.releasedMinor).toBe(30_000);
  });

  // ── 5. the legacy rows this change does not backfill ─────────────────────────────────

  maybe('reconstructs a pre-fix row exactly rather than understating it', async () => {
    /*
      Rows released before this fix have `releasedMinor` at 0 and will never be backfilled -
      reconstructing a figure from status is what the original migration refused to do. The
      fallback instead derives it where it IS derivable: what is still held plus what has been
      confirmed back. That is exact arithmetic over two durable columns, and it is what makes the
      second reversal work for old rows too.
    */
    const s = await approvedSettlement(0, {
      status: 'TRANSFERRED',
      providerTransferId: 'tr_legacy',
      transferredMinor: 60_000,
      releasedMinor: 0, // the shape production wrote for its entire history
    });
    const reverseTransfer = confirmedReversal();
    const { service } = makeService({ reverseTransfer });

    await service.applyRefund(s.eventId, 'usd', 25_000);
    await service.applyRefund(s.eventId, 'usd', 20_000);

    const row = await read(s.id);
    expect(reverseTransfer).toHaveBeenCalledTimes(2);
    // 60,000 held, 45,000 clawed back across two reversals. The second was refused before.
    expect(row.transferredMinor).toBe(15_000);
    expect(reverseTransfer.mock.calls[1][0].amountMinor).toBe(20_000);
  });
});
