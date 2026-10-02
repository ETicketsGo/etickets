import {
  isSweepDue,
  observeCandidate,
  planSweep,
  backoffFor,
  BACKOFF_LADDER_MS,
  DEFAULT_SWEEP_WINDOWS,
  DEFAULT_SWEEP_LIMITS,
  type SweepCandidate,
  type ProviderReconciliationReader,
} from './reversal-sweeper';

const NOW = new Date('2026-10-02T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const candidate = (over: Partial<SweepCandidate> = {}): SweepCandidate => ({
  id: 'att_1',
  settlementId: 's1',
  provider: 'razorpay',
  providerTransferId: 'tr_1',
  currency: 'inr',
  status: 'UNKNOWN',
  requestedAt: ago(30 * 60_000),
  lastReconciledAt: null,
  reconcileCount: 0,
  ...over,
});

const reader = (
  state: Partial<{ amountReversedMinor: number; providerStatusRaw: string | null }> = {},
) =>
  ({
    getTransferReversalState: jest.fn().mockResolvedValue({
      transferId: 'tr_1',
      amountReversedMinor: state.amountReversedMinor ?? 30_000,
      fullyReversed: false,
      providerStatusRaw: state.providerStatusRaw ?? 'partially_reversed',
    }),
  }) satisfies ProviderReconciliationReader & { getTransferReversalState: jest.Mock };

describe('what the sweeper is even able to do', () => {
  it('receives a reader with exactly one method', () => {
    /*
      The structural claim. The sweeper is handed a ProviderReconciliationReader, not a payment
      provider - so creating a transfer, issuing a reversal or refunding is not something it
      declines to do, it is something it has no means to do.
    */
    const r = reader();
    expect(Object.keys(r)).toEqual(['getTransferReversalState']);
  });

  it('18. performs no money-moving operation, given a provider that could', async () => {
    /*
      Scenario 18. Even when handed an object that DOES expose money-moving methods, the sweeper
      only ever calls the reader method - because that is the only one its type knows about.
    */
    const moneyMovers = {
      createTransfer: jest.fn(),
      reverseTransfer: jest.fn(),
      refund: jest.fn(),
      createPayment: jest.fn(),
    };
    const fat = {
      getTransferReversalState: jest.fn().mockResolvedValue({
        transferId: 'tr_1',
        amountReversedMinor: 30_000,
        fullyReversed: false,
        providerStatusRaw: null,
      }),
      ...moneyMovers,
    };

    await observeCandidate(candidate(), fat, NOW);

    expect(fat.getTransferReversalState).toHaveBeenCalledTimes(1);
    // Named rather than looped, so a failure says WHICH money-moving method was reached.
    const called = Object.entries(moneyMovers)
      .filter(([, fn]) => fn.mock.calls.length > 0)
      .map(([name]) => name);
    expect(called).toEqual([]);
  });
});

describe('when an attempt is worth asking about', () => {
  it('asks about UNKNOWN soonest, but not instantly', () => {
    /*
      ── A DELIBERATE CHANGE ─────────────────────────────────────────────────────────
      This used to assert UNKNOWN was due immediately, on the grounds that nothing is coming
      unless we ask. True, and still the reason its window is the shortest - but "immediately"
      meant an attempt marked UNKNOWN a second ago by a request still in flight got a provider
      call on the very next sweep, before the response had any chance to land.

      So UNKNOWN now matures for five minutes. It remains the shortest window of the three,
      because it is the only state where not asking leaves money unaccounted for indefinitely.
    */
    expect(isSweepDue(candidate({ status: 'UNKNOWN', requestedAt: ago(1_000) }), NOW)).toBe(false);
    expect(isSweepDue(candidate({ status: 'UNKNOWN', requestedAt: ago(6 * 60_000) }), NOW)).toBe(
      true,
    );
  });

  it('leaves a REQUESTED attempt alone while it is plausibly still in flight', () => {
    expect(isSweepDue(candidate({ status: 'REQUESTED', requestedAt: ago(60_000) }), NOW)).toBe(
      false,
    );
    expect(isSweepDue(candidate({ status: 'REQUESTED', requestedAt: ago(10 * 60_000) }), NOW)).toBe(
      true,
    );
  });

  it('gives PROCESSING longer, because the provider acknowledged it', () => {
    expect(
      isSweepDue(candidate({ status: 'PROCESSING', requestedAt: ago(10 * 60_000) }), NOW),
    ).toBe(false);
    expect(
      isSweepDue(candidate({ status: 'PROCESSING', requestedAt: ago(45 * 60_000) }), NOW),
    ).toBe(true);
  });

  it('does not ask the same question twice in a row', () => {
    // Otherwise an UNKNOWN attempt would be queried on every single tick, forever.
    expect(isSweepDue(candidate({ lastReconciledAt: ago(5 * 60_000) }), NOW)).toBe(false);
    expect(isSweepDue(candidate({ lastReconciledAt: ago(90 * 60_000) }), NOW)).toBe(true);
  });

  it('skips an attempt with no provider reference, since there is nothing to ask', () => {
    expect(isSweepDue(candidate({ providerTransferId: null }), NOW)).toBe(false);
  });
});

describe('observing', () => {
  it('turns a provider reading into evidence, tagged as a query', async () => {
    const r = reader({ amountReversedMinor: 45_000, providerStatusRaw: 'partially_reversed' });
    const out = await observeCandidate(candidate(), r, NOW);

    expect(out.kind).toBe('RECONCILED');
    expect(out).toMatchObject({
      evidence: {
        provider: 'razorpay',
        providerTransferId: 'tr_1',
        cumulativeReversedMinor: 45_000,
        providerStatusRaw: 'partially_reversed',
        source: 'PROVIDER_QUERY',
      },
    });
  });

  it('claims no knowledge of the original transfer amount', async () => {
    /*
      The reader does not report it, so the evidence says null rather than guessing. The engine
      treats a stated original as something to agree with; inventing one would manufacture a
      mismatch or hide a real one.
    */
    const out = await observeCandidate(candidate(), reader(), NOW);
    expect(
      (out as { evidence: { originalTransferredMinor: number | null } }).evidence
        .originalTransferredMinor,
    ).toBeNull();
  });

  it('returns the evidence rather than applying it', async () => {
    /*
      The sweeper has no accounting of its own. Everything it learns goes through the same
      reconciliation engine as the webhook and the synchronous response, or there would be a
      third implementation of reversal accounting - which is the defect this all began with.
    */
    const out = await observeCandidate(candidate(), reader(), NOW);
    expect(out).toHaveProperty('evidence');
    expect(out).not.toHaveProperty('applied');
  });

  it('does not call the provider for an attempt that is not due', async () => {
    const r = reader();
    const out = await observeCandidate(
      candidate({ status: 'REQUESTED', requestedAt: ago(10_000) }),
      r,
      NOW,
    );
    expect(out.kind).toBe('NOT_DUE');
    expect(r.getTransferReversalState).not.toHaveBeenCalled();
  });

  it('leaves the attempt untouched when the provider cannot be reached', async () => {
    /*
      An unreachable provider is not evidence of anything. Turning "we could not ask" into
      "nothing happened" is exactly how an ambiguous outcome becomes a false conclusion, so this
      reports the failure and changes nothing.
    */
    const r = {
      getTransferReversalState: jest.fn().mockRejectedValue(new Error('ETIMEDOUT')),
    };
    const out = await observeCandidate(candidate(), r, NOW);

    expect(out).toMatchObject({ kind: 'PROVIDER_UNREACHABLE', error: 'ETIMEDOUT' });
    expect(out).not.toHaveProperty('evidence');
  });

  it('truncates a provider error rather than storing an essay', async () => {
    const r = {
      getTransferReversalState: jest.fn().mockRejectedValue(new Error('x'.repeat(5000))),
    };
    const out = await observeCandidate(candidate(), r, NOW);
    expect((out as { error: string }).error.length).toBe(200);
  });
});

describe('the windows are stated, not scattered', () => {
  it('waits least for UNKNOWN, which is the state nothing resolves on its own', () => {
    // The only state where not asking leaves money unaccounted for indefinitely.
    expect(DEFAULT_SWEEP_WINDOWS.unknownMs).toBeLessThan(DEFAULT_SWEEP_WINDOWS.requestedMs);
    expect(DEFAULT_SWEEP_WINDOWS.requestedMs).toBeLessThan(DEFAULT_SWEEP_WINDOWS.processingMs);
  });

  it('honours windows passed in, so they are tunable per deployment', () => {
    const tight = { unknownMs: 1_000, requestedMs: 1_000, processingMs: 1_000 };
    expect(
      isSweepDue(candidate({ status: 'REQUESTED', requestedAt: ago(5_000) }), NOW, tight),
    ).toBe(true);
  });

  it('holds each state behind its own window before the first look', () => {
    const young = { status: 'PROCESSING' as const, requestedAt: ago(60_000) };
    expect(isSweepDue(candidate(young), NOW)).toBe(false);
    expect(isSweepDue(candidate({ ...young, status: 'UNKNOWN' }), NOW)).toBe(false);
    // The shorter UNKNOWN window is reached first.
    expect(isSweepDue(candidate({ status: 'UNKNOWN', requestedAt: ago(6 * 60_000) }), NOW)).toBe(
      true,
    );
  });
});

describe('the backoff ladder', () => {
  it('lengthens and then caps, because an unresolvable attempt is never abandoned', () => {
    expect(BACKOFF_LADDER_MS).toEqual([
      15 * 60_000,
      30 * 60_000,
      60 * 60_000,
      7_200_000,
      14_400_000,
    ]);
    // Strictly increasing, or a later look would fall sooner than an earlier one.
    for (let i = 1; i < BACKOFF_LADDER_MS.length; i += 1) {
      expect(BACKOFF_LADDER_MS[i]).toBeGreaterThan(BACKOFF_LADDER_MS[i - 1]);
    }
    expect(backoffFor(1)).toBe(15 * 60_000);
    expect(backoffFor(5)).toBe(14_400_000);
    // Capped, not unbounded: money in an unknown state keeps being checked forever.
    expect(backoffFor(500)).toBe(14_400_000);
  });

  it('reads a nonsense count as the first rung rather than as due immediately', () => {
    // A data fault must not become a reason to hammer the provider.
    for (const bad of [0, -1, NaN, Infinity, 0.5]) {
      expect(backoffFor(bad)).toBe(BACKOFF_LADDER_MS[0]);
    }
  });

  it('decides a re-look by the ladder, not by the status', () => {
    const looked = (reconcileCount: number, sinceMs: number) =>
      candidate({ status: 'UNKNOWN', reconcileCount, lastReconciledAt: ago(sinceMs) });

    // One look in: fifteen minutes.
    expect(isSweepDue(looked(1, 14 * 60_000), NOW)).toBe(false);
    expect(isSweepDue(looked(1, 16 * 60_000), NOW)).toBe(true);
    // Four looks in: two hours, so sixteen minutes is far too soon.
    expect(isSweepDue(looked(4, 16 * 60_000), NOW)).toBe(false);
    expect(isSweepDue(looked(4, 3 * 60 * 60_000), NOW)).toBe(true);
  });

  it('does not treat a long-stuck attempt as more urgent for being stuck', () => {
    /*
      The intuition to resist. An attempt nobody has resolved in a month is LESS likely to
      resolve on its own, not more, so age is not urgency - and letting age jump the ladder is
      how a provider outage becomes a hammering poller.
    */
    const ancient = candidate({
      status: 'UNKNOWN',
      requestedAt: ago(30 * 24 * 60 * 60_000),
      reconcileCount: 5,
      lastReconciledAt: ago(60 * 60_000),
    });
    expect(isSweepDue(ancient, NOW)).toBe(false);
  });
});

describe('planning a bounded sweep', () => {
  const due = (id: string, lastReconciledAt: Date | null, reconcileCount = 1) =>
    candidate({ id, status: 'UNKNOWN', lastReconciledAt, reconcileCount });

  it('bounds the batch, so a backlog cannot become an unbounded run', () => {
    const many = Array.from({ length: 200 }, (_, i) => due(`a${i}`, ago(10 * 60 * 60_000)));
    expect(planSweep(many, NOW).length).toBe(DEFAULT_SWEEP_LIMITS.batchSize);
  });

  it('takes the least recently looked first, so nothing can starve', () => {
    /*
      With a backlog larger than one batch, an arbitrary order lets the same rows win every
      sweep while the rest are never reached. Looking at a row moves it to the back.
    */
    const plan = planSweep(
      [
        due('recent', ago(5 * 60 * 60_000)),
        due('oldest', ago(20 * 60 * 60_000)),
        due('middle', ago(9 * 60 * 60_000)),
      ],
      NOW,
      DEFAULT_SWEEP_WINDOWS,
      { batchSize: 2, concurrency: 1 },
    );
    expect(plan.map((c) => c.id)).toEqual(['oldest', 'middle']);
  });

  it('puts a never-looked attempt ahead of a backlog of old ones', () => {
    const plan = planSweep(
      [due('looked', ago(20 * 60 * 60_000)), due('never', null, 0)],
      NOW,
      DEFAULT_SWEEP_WINDOWS,
      { batchSize: 1, concurrency: 1 },
    );
    expect(plan.map((c) => c.id)).toEqual(['never']);
  });

  it('leaves out everything not due, rather than asking about it anyway', () => {
    const plan = planSweep(
      [
        due('due', ago(20 * 60 * 60_000)),
        due('tooSoon', ago(60_000)),
        candidate({ id: 'noRef', providerTransferId: null }),
      ],
      NOW,
    );
    expect(plan.map((c) => c.id)).toEqual(['due']);
  });

  it('is reproducible from the same input', () => {
    const rows = [due('b', ago(60 * 60_000)), due('a', ago(60 * 60_000))];
    // Tied on last-looked, so the tiebreak has to be stable or a sweep is not repeatable.
    expect(planSweep(rows, NOW).map((c) => c.id)).toEqual(
      planSweep([...rows].reverse(), NOW).map((c) => c.id),
    );
  });

  it('plans nothing when the batch size is nonsense, rather than everything', () => {
    const rows = [due('a', ago(60 * 60_000))];
    for (const bad of [0, -5, NaN]) {
      expect(
        planSweep(rows, NOW, DEFAULT_SWEEP_WINDOWS, { batchSize: bad, concurrency: 1 }),
      ).toEqual([]);
    }
  });
});
