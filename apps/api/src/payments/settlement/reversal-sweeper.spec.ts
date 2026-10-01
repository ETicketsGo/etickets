import {
  isSweepDue,
  observeCandidate,
  DEFAULT_SWEEP_WINDOWS,
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
  requestedAt: ago(10 * 60_000),
  lastReconciledAt: null,
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
  it('asks about UNKNOWN as soon as the recheck window allows', () => {
    // Nothing is coming for an UNKNOWN attempt unless we ask, so it has no maturing period.
    expect(isSweepDue(candidate({ status: 'UNKNOWN', requestedAt: ago(1_000) }), NOW)).toBe(true);
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
  it('has defaults that can be argued with', () => {
    expect(DEFAULT_SWEEP_WINDOWS.requestedMs).toBeLessThan(DEFAULT_SWEEP_WINDOWS.processingMs);
    expect(DEFAULT_SWEEP_WINDOWS.processingMs).toBeLessThan(DEFAULT_SWEEP_WINDOWS.recheckMs);
  });

  it('honours windows passed in, so they are tunable per deployment', () => {
    const tight = { requestedMs: 1_000, processingMs: 1_000, recheckMs: 1_000 };
    expect(
      isSweepDue(candidate({ status: 'REQUESTED', requestedAt: ago(5_000) }), NOW, tight),
    ).toBe(true);
  });
});
