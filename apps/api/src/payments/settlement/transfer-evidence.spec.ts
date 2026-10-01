import {
  reconcileTransferEvidence,
  outstandingMinor,
  type TransferEvidence,
  type SettlementReversalFacts,
  type EvidenceSource,
} from './transfer-evidence';

const facts = (over: Partial<SettlementReversalFacts> = {}): SettlementReversalFacts => ({
  settlementId: 's1',
  providerTransferId: 'tr_1',
  currency: 'inr',
  releasedMinor: 100_000,
  confirmedReversedMinor: 0,
  unresolvedAttempts: 0,
  ...over,
});

const evidence = (over: Partial<TransferEvidence> = {}): TransferEvidence => ({
  provider: 'razorpay',
  providerTransferId: 'tr_1',
  currency: 'INR',
  originalTransferredMinor: null,
  cumulativeReversedMinor: 0,
  providerStatusRaw: null,
  observedAt: new Date('2026-10-02T10:00:00Z'),
  source: 'WEBHOOK',
  ...over,
});

const SOURCES: EvidenceSource[] = ['SYNC_RESPONSE', 'WEBHOOK', 'PROVIDER_QUERY'];

/**
 * The engine both evidence paths run through. Before this, the webhook path had an accounting
 * implementation of its own that ignored amounts entirely - which is how the same provider money
 * movement came to be described two different ways.
 */
describe('comparing, never adding', () => {
  it('reports only what is NEW when the provider figure is cumulative', () => {
    /*
      The arithmetic that matters. Provider says 300 total reversed, we have already confirmed
      200, so 100 is new. Adding the provider's figure would double-count 200 of it.
    */
    const out = reconcileTransferEvidence(
      facts({ confirmedReversedMinor: 20_000 }),
      evidence({ cumulativeReversedMinor: 30_000 }),
    );
    expect(out).toEqual({
      kind: 'NEWLY_CONFIRMED',
      deltaMinor: 10_000,
      cumulativeReversedMinor: 30_000,
    });
  });

  it('agrees when the provider confirms exactly what we hold', () => {
    const out = reconcileTransferEvidence(
      facts({ confirmedReversedMinor: 30_000 }),
      evidence({ cumulativeReversedMinor: 30_000 }),
    );
    expect(out).toMatchObject({ kind: 'AGREES' });
  });

  it('is idempotent: the same evidence twice adds nothing the second time', () => {
    const f = facts({ confirmedReversedMinor: 0 });
    const e = evidence({ cumulativeReversedMinor: 30_000 });

    const first = reconcileTransferEvidence(f, e);
    expect(first).toMatchObject({ kind: 'NEWLY_CONFIRMED', deltaMinor: 30_000 });

    // After applying the first, the same evidence is simply agreement.
    const second = reconcileTransferEvidence({ ...f, confirmedReversedMinor: 30_000 }, e);
    expect(second).toMatchObject({ kind: 'AGREES' });
  });

  it.each(SOURCES)('reaches the same answer from %s', (source) => {
    // Source is audit information. It must never change the arithmetic.
    const out = reconcileTransferEvidence(
      facts({ confirmedReversedMinor: 10_000 }),
      evidence({ cumulativeReversedMinor: 25_000, source }),
    );
    expect(out).toMatchObject({ kind: 'NEWLY_CONFIRMED', deltaMinor: 15_000 });
  });
});

describe('out-of-order evidence', () => {
  it('treats a late, lower cumulative figure as STALE while work is in flight', () => {
    /*
      Observe 50000, then an older delivery reports 30000. Confirmed money must never decrease
      because a webhook arrived late.
    */
    const out = reconcileTransferEvidence(
      facts({ confirmedReversedMinor: 50_000, unresolvedAttempts: 1 }),
      evidence({ cumulativeReversedMinor: 30_000 }),
    );
    expect(out).toMatchObject({
      kind: 'STALE',
      reportedMinor: 30_000,
      alreadyConfirmedMinor: 50_000,
    });
  });

  it('treats a lower figure with NOTHING in flight as a mismatch', () => {
    /*
      Nothing is pending, so this is not late delivery - the provider is asserting that less has
      come back than we recorded as settled. A contradiction about settled money.
    */
    const out = reconcileTransferEvidence(
      facts({ confirmedReversedMinor: 50_000, unresolvedAttempts: 0 }),
      evidence({ cumulativeReversedMinor: 30_000 }),
    );
    expect(out.kind).toBe('MISMATCH');
  });

  it('never lets confirmed money decrease, whichever branch is taken', () => {
    for (const unresolved of [0, 1, 5]) {
      const out = reconcileTransferEvidence(
        facts({ confirmedReversedMinor: 50_000, unresolvedAttempts: unresolved }),
        evidence({ cumulativeReversedMinor: 10_000 }),
      );
      expect(out.kind).not.toBe('NEWLY_CONFIRMED');
      expect(out.kind).not.toBe('AGREES');
    }
  });
});

describe('evidence that cannot be applied', () => {
  it('refuses evidence about a different transfer', () => {
    const out = reconcileTransferEvidence(facts(), evidence({ providerTransferId: 'tr_OTHER' }));
    expect(out).toMatchObject({ kind: 'MISMATCH', reason: 'evidence is for a different transfer' });
  });

  it('refuses evidence when we hold no transfer reference at all', () => {
    const out = reconcileTransferEvidence(facts({ providerTransferId: null }), evidence());
    expect(out.kind).toBe('MISMATCH');
  });

  it('refuses a different currency', () => {
    const out = reconcileTransferEvidence(
      facts({ currency: 'inr' }),
      evidence({ currency: 'USD' }),
    );
    expect(out).toMatchObject({ kind: 'MISMATCH', reason: 'currency does not match' });
  });

  it('folds case, because settlements store lower case and providers vary', () => {
    const out = reconcileTransferEvidence(
      facts({ currency: 'inr', confirmedReversedMinor: 0 }),
      evidence({ currency: 'INR', cumulativeReversedMinor: 5_000 }),
    );
    expect(out.kind).toBe('NEWLY_CONFIRMED');
  });

  it('refuses more reversed than was ever released', () => {
    /*
      Accepting this would drive the outstanding amount negative - the organizer would appear to
      owe money that was never sent to them.
    */
    const out = reconcileTransferEvidence(
      facts({ releasedMinor: 100_000 }),
      evidence({ cumulativeReversedMinor: 150_000 }),
    );
    expect(out).toMatchObject({
      kind: 'MISMATCH',
      reason: 'provider reports more reversed than was ever released',
    });
  });

  it('refuses a disagreement about the ORIGINAL transfer amount', () => {
    const out = reconcileTransferEvidence(
      facts({ releasedMinor: 100_000 }),
      evidence({ originalTransferredMinor: 90_000, cumulativeReversedMinor: 10_000 }),
    );
    expect(out).toMatchObject({
      kind: 'MISMATCH',
      reason: 'provider and ledger disagree on the original transfer amount',
    });
  });

  it('accepts a matching original transfer amount', () => {
    const out = reconcileTransferEvidence(
      facts({ releasedMinor: 100_000 }),
      evidence({ originalTransferredMinor: 100_000, cumulativeReversedMinor: 10_000 }),
    );
    expect(out.kind).toBe('NEWLY_CONFIRMED');
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses an impossible reversed amount (%p)',
    (bad) => {
      const out = reconcileTransferEvidence(facts(), evidence({ cumulativeReversedMinor: bad }));
      expect(out.kind).toBe('MISMATCH');
    },
  );

  it('never clamps a contradiction into agreement', () => {
    /*
      Bending a figure to make the totals add up produces a ledger nobody can audit. Every
      contradictory case above returns MISMATCH, and the mismatch carries both numbers so a
      person can see what disagreed.
    */
    const out = reconcileTransferEvidence(
      facts({ releasedMinor: 100_000 }),
      evidence({ cumulativeReversedMinor: 150_000 }),
    );
    expect(out.kind).toBe('MISMATCH');
    expect((out as { detail: Record<string, unknown> }).detail).toMatchObject({
      cumulativeReversedMinor: 150_000,
      releasedMinor: 100_000,
    });
  });
});

describe('the four questions the model must answer', () => {
  it('outstanding is released minus confirmed, and never invented', () => {
    expect(
      outstandingMinor(facts({ releasedMinor: 100_000, confirmedReversedMinor: 30_000 })),
    ).toBe(70_000);
    expect(
      outstandingMinor(facts({ releasedMinor: 100_000, confirmedReversedMinor: 100_000 })),
    ).toBe(0);
  });

  it('stays within bounds across every reconcilable state', () => {
    // 0 <= confirmed <= released, for every state the engine will accept.
    for (let confirmed = 0; confirmed <= 100_000; confirmed += 10_000) {
      const f = facts({ releasedMinor: 100_000, confirmedReversedMinor: confirmed });
      const out = outstandingMinor(f);
      expect(out).toBeGreaterThanOrEqual(0);
      expect(out).toBeLessThanOrEqual(100_000);
    }
  });
});
