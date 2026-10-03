import {
  providerFinanceEntry,
  type ProviderReversalEvidence,
  type ProviderSettlementRow,
} from './provider-finance.producer';

/**
 * The provider path's amounts, and the one rule everything else follows from:
 * `organizerNetMinor` means the same thing at every lifecycle stage.
 */

const settlement = (over: Partial<ProviderSettlementRow> = {}): ProviderSettlementRow => ({
  id: 's1',
  organizationId: 'org1',
  eventId: 'e1',
  currency: 'inr',
  status: 'ELIGIBLE',
  grossSalesMinor: 200_000,
  platformFeesMinor: 10_000,
  refundsMinor: 0,
  disputesMinor: 0,
  reserveMinor: 0,
  releasedMinor: 0,
  transferredMinor: 0,
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-30T00:00:00Z'),
  ...over,
});

const clean: ProviderReversalEvidence = { unresolvedCount: 0, reconciliationMismatch: false };

describe('organizerNetMinor means one thing', () => {
  it('is the entitlement, not the disbursement instruction', () => {
    const { entry, integrity } = providerFinanceEntry(settlement(), clean);
    expect(integrity).toEqual([]);
    // grossSalesMinor, already net of the platform fee.
    expect(entry.money.organizerNetMinor).toBe(200_000);
  });

  it('does not change when money moves', () => {
    /*
      ── THE LIFECYCLE STABILITY PROOF ────────────────────────────────────────────────
      The same economic entitlement walked through the whole lifecycle. If organizerNetMinor were
      payableMinor it would read 0 for the first three stages - payableMinor is written only
      inside release() - and then jump to a transfer amount. One field answering two different
      financial questions depending on status is exactly what this forbids.
    */
    const stages = ['PENDING', 'HELD', 'ELIGIBLE', 'APPROVED'] as const;
    for (const status of stages) {
      const { entry } = providerFinanceEntry(settlement({ status }), clean);
      expect(`${status} net=${entry.money.organizerNetMinor}`).toBe(`${status} net=200000`);
      // Nothing has moved, so there is no movement to report.
      expect(entry.movement).toBeUndefined();
    }

    /*
      Money now moves - and deliberately NOT the whole entitlement. A 20 000 reserve was withheld,
      so 180 000 was sent. That gap is what makes this test able to fail: with equal numbers the
      entitlement reading and the holdings reading coincide and a lifecycle-dependent mapping
      would slip through unnoticed. (Found exactly that way: the first version of this test used
      200 000 throughout and did not catch the injected drift.)
    */
    for (const status of ['TRANSFER_PROCESSING', 'TRANSFERRED'] as const) {
      const { entry } = providerFinanceEntry(
        settlement({
          status,
          reserveMinor: 20_000,
          releasedMinor: 180_000,
          transferredMinor: 180_000,
        }),
        clean,
      );
      // Entitlement, not the 180 000 that actually moved.
      expect(`${status} net=${entry.money.organizerNetMinor}`).toBe(`${status} net=200000`);
      expect(entry.movement).toEqual({
        transferredOutMinor: 180_000,
        recoveredMinor: 0,
        stillOutMinor: 180_000,
      });
    }
  });

  it('is never the amount still held by the organizer', () => {
    // Half came back. Entitlement is untouched by that; holdings are not.
    const { entry } = providerFinanceEntry(
      settlement({
        status: 'PARTIALLY_REFUNDED',
        releasedMinor: 200_000,
        transferredMinor: 120_000,
        refundsMinor: 80_000,
      }),
      clean,
    );
    expect(entry.money.organizerNetMinor).toBe(200_000);
    expect(entry.movement!.stillOutMinor).toBe(120_000);
    expect(entry.movement!.recoveredMinor).toBe(80_000);
  });
});

describe('zero is not the same statement as unset', () => {
  it('omits refunds before release, because nobody has computed them', () => {
    /*
      refundsMinor, disputesMinor and reserveMinor are not maintained by the settlement upsert -
      only release() computes them. So a 0 before release means "never calculated", and emitting
      it would assert "no refunds" about a settlement whose refunds nobody has worked out.
    */
    const { entry } = providerFinanceEntry(settlement({ status: 'ELIGIBLE' }), clean);
    expect(entry.money.refundsMinor).toBeUndefined();
    expect('refundsMinor' in entry.money).toBe(false);
    expect(JSON.stringify(entry.money)).not.toContain('refundsMinor');
  });

  it('emits a proven zero after release', () => {
    const { entry } = providerFinanceEntry(
      settlement({ status: 'TRANSFERRED', releasedMinor: 200_000, transferredMinor: 200_000 }),
      clean,
    );
    expect(entry.money.refundsMinor).toBe(0);
    expect(JSON.stringify(entry.money)).toContain('refundsMinor');
  });

  it('omits adjustments entirely when there are none to report', () => {
    const { entry } = providerFinanceEntry(
      settlement({ status: 'TRANSFERRED', releasedMinor: 1, transferredMinor: 1 }),
      clean,
    );
    expect(entry.money.adjustmentsMinor).toBeUndefined();
  });

  it('reports disputes and reserve together as adjustments', () => {
    const { entry } = providerFinanceEntry(
      settlement({
        status: 'TRANSFERRED',
        releasedMinor: 150_000,
        transferredMinor: 150_000,
        disputesMinor: 20_000,
        reserveMinor: 30_000,
      }),
      clean,
    );
    // The two provider-side concepts with no platform-ledger equivalent.
    expect(entry.money.adjustmentsMinor).toBe(50_000);
  });
});

describe('fees are not decomposed beyond the evidence', () => {
  it('reports one honest aggregate, marked deducted', () => {
    const { entry } = providerFinanceEntry(settlement(), clean);
    expect(entry.money.fees).toEqual([
      { key: 'PLATFORM_COMBINED', amountMinor: 10_000, deducted: true },
    ]);
  });

  it('invents no processing, convenience or platform split', () => {
    const keys = providerFinanceEntry(settlement(), clean).entry.money.fees!.map((f) => f.key);
    expect(keys).not.toContain('PAYMENT_PROCESSING');
    expect(keys).not.toContain('BOOKING');
    expect(keys).not.toContain('PLATFORM');
  });

  it('records no gross face value, because this path never stored one', () => {
    /*
      grossSalesMinor is already net of the platform fee despite its name. Adding the fee back
      would invent a quantity that excludes tax and corresponds to nothing stored.
    */
    const { entry } = providerFinanceEntry(settlement(), clean);
    expect(entry.money.grossFaceValueMinor).toBeUndefined();
  });
});

describe('the partial reversal walk, asserted integer by integer', () => {
  /*
    One settlement, seven steps. Entitlement holds at 200 000 throughout; movement and refund
    accounting are what change. Status labels are asserted alongside the amounts, never instead
    of them.
  */
  const walk = (over: Partial<ProviderSettlementRow>, ev: ProviderReversalEvidence = clean) =>
    providerFinanceEntry(settlement({ grossSalesMinor: 200_000, ...over }), ev);

  it('1. becomes payable: entitlement known, nothing moved', () => {
    const { entry } = walk({ status: 'ELIGIBLE' });
    expect(entry.money.organizerNetMinor).toBe(200_000);
    expect(entry.movement).toBeUndefined();
    expect(entry.state).toBe('PENDING');
  });

  it('2. transfer completes: entitlement unchanged, 200 000 out', () => {
    const { entry } = walk({
      status: 'TRANSFERRED',
      releasedMinor: 200_000,
      transferredMinor: 200_000,
    });
    expect(entry.money.organizerNetMinor).toBe(200_000);
    expect(entry.movement).toEqual({
      transferredOutMinor: 200_000,
      recoveredMinor: 0,
      stillOutMinor: 200_000,
    });
    expect(entry.state).toBe('PAID');
  });

  it('3. a refund is recorded: accounting moves, money has not', () => {
    /*
      refundsMinor is ACCOUNTING. It is not proof that provider money was recovered - nothing has
      come back yet, so recovered stays 0 and the organizer is still holding all of it.
    */
    const { entry } = walk({
      status: 'PARTIALLY_REFUNDED',
      releasedMinor: 200_000,
      transferredMinor: 200_000,
      refundsMinor: 50_000,
    });
    expect(entry.money.refundsMinor).toBe(50_000);
    expect(entry.movement!.recoveredMinor).toBe(0);
    expect(entry.movement!.stillOutMinor).toBe(200_000);
    expect(entry.money.organizerNetMinor).toBe(200_000);
  });

  it('4. a reversal is REQUESTED: still nothing moved, and a person is needed', () => {
    const { entry } = walk(
      {
        status: 'PARTIALLY_REFUNDED',
        releasedMinor: 200_000,
        transferredMinor: 200_000,
        refundsMinor: 50_000,
      },
      { unresolvedCount: 1, reconciliationMismatch: false },
    );
    expect(entry.movement!.recoveredMinor).toBe(0);
    // A request does not prove money moved, and an unresolved one must not read as finished.
    expect(entry.state).toBe('ATTENTION_REQUIRED');
    expect(entry.sourceStatus).toBe('PARTIALLY_REFUNDED');
  });

  it('5. the reversal becomes UNKNOWN: amounts untouched, still attention', () => {
    const { entry } = walk(
      {
        status: 'PARTIALLY_REFUNDED',
        releasedMinor: 200_000,
        transferredMinor: 200_000,
        refundsMinor: 50_000,
      },
      { unresolvedCount: 1, reconciliationMismatch: false },
    );
    // UNKNOWN is not zero and not failure. No amount may move because of ambiguity.
    expect(entry.movement!.recoveredMinor).toBe(0);
    expect(entry.movement!.stillOutMinor).toBe(200_000);
    expect(entry.state).toBe('ATTENTION_REQUIRED');
  });

  it('6. the reversal is authoritatively confirmed: 50 000 recovered', () => {
    const { entry } = walk({
      status: 'PARTIALLY_REFUNDED',
      releasedMinor: 200_000,
      transferredMinor: 150_000,
      refundsMinor: 50_000,
    });
    expect(entry.movement).toEqual({
      transferredOutMinor: 200_000,
      recoveredMinor: 50_000,
      stillOutMinor: 150_000,
    });
    // Entitlement still unchanged by any of it.
    expect(entry.money.organizerNetMinor).toBe(200_000);
  });

  it('7. a second partial reversal: recovered accumulates, entitlement does not move', () => {
    const { entry } = walk({
      status: 'PARTIALLY_REFUNDED',
      releasedMinor: 200_000,
      transferredMinor: 110_000,
      refundsMinor: 90_000,
    });
    expect(entry.movement).toEqual({
      transferredOutMinor: 200_000,
      recoveredMinor: 90_000,
      stillOutMinor: 110_000,
    });
    expect(entry.money.organizerNetMinor).toBe(200_000);
  });

  it('a full reversal is not a return to the platform', () => {
    /*
      Everything came back, and that is all it says. REVERSED does not mean RETURN_TO_PLATFORM -
      the status cannot say whether this was an administrative correction leaving the organizer
      unpaid or a customer refund meaning the revenue no longer exists.
    */
    const { entry } = walk({
      status: 'REVERSED',
      releasedMinor: 200_000,
      transferredMinor: 0,
      refundsMinor: 200_000,
    });
    expect(entry.movement).toEqual({
      transferredOutMinor: 200_000,
      recoveredMinor: 200_000,
      stillOutMinor: 0,
    });
    // Not PAID. Somebody has to look.
    expect(entry.state).toBe('ATTENTION_REQUIRED');
    expect(entry.sourceStatus).toBe('REVERSED');
  });
});

describe('lifecycle is derived independently of the amounts', () => {
  it.each([
    ['PENDING', 'PENDING'],
    ['HELD', 'PENDING'],
    ['ELIGIBLE', 'PENDING'],
    ['APPROVED', 'IN_PROGRESS'],
    ['BLOCKED', 'ATTENTION_REQUIRED'],
    ['FAILED', 'ATTENTION_REQUIRED'],
  ])('maps unreleased %s to %s', (status, expected) => {
    const { entry } = providerFinanceEntry(settlement({ status }), clean);
    expect(entry.state).toBe(expected);
    expect(entry.sourceStatus).toBe(status);
  });

  it.each([
    ['TRANSFER_PROCESSING', 'IN_PROGRESS'],
    ['TRANSFERRED', 'PAID'],
    ['PARTIALLY_REFUNDED', 'PARTIALLY_REFUNDED'],
    ['REVERSED', 'ATTENTION_REQUIRED'],
  ])('maps released %s to %s', (status, expected) => {
    const { entry } = providerFinanceEntry(
      settlement({ status, releasedMinor: 100_000, transferredMinor: 100_000 }),
      clean,
    );
    expect(entry.state).toBe(expected);
  });

  it('never lets a partial refund collapse into paid', () => {
    const { entry } = providerFinanceEntry(
      settlement({
        status: 'PARTIALLY_REFUNDED',
        releasedMinor: 100_000,
        transferredMinor: 60_000,
      }),
      clean,
    );
    expect(entry.state).not.toBe('PAID');
    expect(entry.state).toBe('PARTIALLY_REFUNDED');
  });

  it('guesses no state for a status it cannot map', () => {
    const { entry, integrity } = providerFinanceEntry(settlement({ status: 'NEW_THING' }), clean);
    expect(integrity.map((f) => f.code)).toContain('UNMAPPED_STATUS');
    expect(entry.state).toBe('ATTENTION_REQUIRED');
  });

  it('surfaces a reconciliation mismatch without correcting any amount', () => {
    const { entry } = providerFinanceEntry(
      settlement({ status: 'TRANSFERRED', releasedMinor: 100_000, transferredMinor: 100_000 }),
      { unresolvedCount: 0, reconciliationMismatch: true },
    );
    expect(entry.state).toBe('ATTENTION_REQUIRED');
    // No fabricated correction: the stored figures are reported exactly as they stand.
    expect(entry.movement).toEqual({
      transferredOutMinor: 100_000,
      recoveredMinor: 0,
      stillOutMinor: 100_000,
    });
    expect(entry.money.organizerNetMinor).toBe(200_000);
  });
});

describe('contradictory movement evidence is reported, not smoothed over', () => {
  it('flags more still out than was ever sent', () => {
    const { entry, integrity } = providerFinanceEntry(
      settlement({ status: 'TRANSFERRED', releasedMinor: 100_000, transferredMinor: 150_000 }),
      clean,
    );
    expect(integrity.map((f) => f.field)).toContain('transferredMinor');
    expect(entry.state).toBe('ATTENTION_REQUIRED');
    // Clamped at zero rather than reported as a negative recovery.
    expect(entry.movement!.recoveredMinor).toBe(0);
  });

  it('reports a released status with no recorded amount as a LIMITATION, not a contradiction', () => {
    /*
      ── A DELIBERATE CHANGE ─────────────────────────────────────────────────────────
      This used to assert TOTALS_DISAGREE and ATTENTION_REQUIRED, on the reasoning that a
      TRANSFERRED settlement recording nothing as released contradicts itself.

      It does not. `releasedMinor` went unwritten for most of this platform's history, so it is 0
      on every settlement released before that was fixed, and those rows are not backfilled. The
      old assertion would therefore have marked real historical money as broken, and the fixtures
      only hid that by setting a field the writer did not set.

      Nothing is recorded, which is a gap in what we keep, not two sources disagreeing.
    */
    const { entry, integrity } = providerFinanceEntry(
      settlement({ status: 'TRANSFERRED', releasedMinor: 0, transferredMinor: 0 }),
      clean,
    );
    expect(integrity.map((f) => f.code)).toEqual(['MOVEMENT_NOT_RECORDED']);
    expect(integrity.some((f) => f.code === 'TOTALS_DISAGREE')).toBe(false);
    // And it does not call somebody about a settlement that is fine.
    expect(entry.state).toBe('PAID');
  });

  it('flags a release recorded against a status that has not released', () => {
    const { integrity } = providerFinanceEntry(
      settlement({ status: 'ELIGIBLE', releasedMinor: 50_000 }),
      clean,
    );
    expect(integrity.some((f) => f.detail.includes('has not been sent'))).toBe(true);
  });

  it('flags a negative movement amount', () => {
    const { integrity } = providerFinanceEntry(
      settlement({ status: 'TRANSFERRED', releasedMinor: -1, transferredMinor: -1 }),
      clean,
    );
    expect(integrity.length).toBeGreaterThan(0);
  });
});

describe('attribution and currency', () => {
  it('is always authoritative, because a settlement is per event', () => {
    const { entry } = providerFinanceEntry(settlement(), clean);
    expect(entry.attribution).toBe('AUTHORITATIVE');
    expect(entry.eventId).toBe('e1');
    expect(entry.coveredEventIds).toBeUndefined();
    // Not a period concept.
    expect(entry.periodStart).toBeNull();
    expect(entry.periodEnd).toBeNull();
  });

  it('folds currency case without rewriting the stored value', () => {
    // Settlements store lower case; Finance compares upper.
    const { entry } = providerFinanceEntry(settlement({ currency: 'inr' }), clean);
    expect(entry.currency).toBe('INR');
  });

  it('flags an unreadable currency rather than inventing one', () => {
    const { entry, integrity } = providerFinanceEntry(settlement({ currency: '  ' }), clean);
    expect(integrity.map((f) => f.code)).toContain('CURRENCY_UNREADABLE');
    expect(entry.state).toBe('ATTENTION_REQUIRED');
  });
});

/*
  ── THE SHAPE PRODUCTION WROTE FOR ITS ENTIRE HISTORY ─────────────────────────────────
  `release()` records `releasedMinor` now, but nothing did before that fix, so it stayed at its
  schema default of 0 on every row ever released - and those rows are deliberately not
  backfilled, because reconstructing the figure from status is what the original migration
  refused to do.

  Every test above sets releasedMinor explicitly, which is a shape the writer never produced.
  That gap is exactly how a producer can pass a real-Postgres suite and still be wrong against
  real data, so these use the historical shape: released status, real transferredMinor,
  releasedMinor at 0. What the writer does now is proven in
  release-writer.integration-postgres.spec.ts, against the real service.
*/
describe('a settlement released before releasedMinor was recorded', () => {
  const asProductionWrites = (over: Partial<ProviderSettlementRow> = {}) =>
    settlement({
      status: 'TRANSFERRED',
      grossSalesMinor: 120_000,
      // What release() actually sets...
      transferredMinor: 95_000,
      // ...and what it does not.
      releasedMinor: 0,
      ...over,
    });

  it('does not call a healthy settlement broken', () => {
    const { entry, integrity } = providerFinanceEntry(asProductionWrites(), clean);
    // Before this fix, BOTH naive checks fired and every real settlement read as contradictory.
    expect(integrity.filter((f) => f.code === 'TOTALS_DISAGREE')).toEqual([]);
    expect(entry.state).toBe('PAID');
  });

  it('withholds movement rather than reporting that nothing was sent', () => {
    const { entry } = providerFinanceEntry(asProductionWrites(), clean);
    /*
      transferredOutMinor would have been 0 - a confident statement that the provider never sent
      anything, about a settlement that is TRANSFERRED. Absent is the only honest answer.
    */
    expect(entry.movement).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain('movement');
  });

  it('says why the movement is missing', () => {
    const { integrity } = providerFinanceEntry(asProductionWrites(), clean);
    const found = integrity.filter((f) => f.code === 'MOVEMENT_NOT_RECORDED');
    expect(found).toHaveLength(1);
    expect(found[0].field).toBe('releasedMinor');
    expect(found[0].detail).toMatch(/never recorded/i);
  });

  it('keeps the entitlement, which IS recorded', () => {
    /*
      The important half. grossSalesMinor is genuinely maintained by the settlement upsert, so
      what the organizer is owed is unaffected by the movement gap.
    */
    const { entry } = providerFinanceEntry(asProductionWrites(), clean);
    expect(entry.money.organizerNetMinor).toBe(120_000);
  });

  it('still reports a genuine contradiction when the figure IS recorded', () => {
    // The real impossibility: a non-zero released amount smaller than what is still out.
    const { entry, integrity } = providerFinanceEntry(
      asProductionWrites({ releasedMinor: 50_000, transferredMinor: 90_000 }),
      clean,
    );
    expect(integrity.map((f) => f.code)).toContain('TOTALS_DISAGREE');
    expect(entry.state).toBe('ATTENTION_REQUIRED');
  });

  it('still reports movement when the figure IS recorded', () => {
    const { entry, integrity } = providerFinanceEntry(
      asProductionWrites({ releasedMinor: 120_000, transferredMinor: 95_000 }),
      clean,
    );
    expect(integrity).toEqual([]);
    expect(entry.movement).toEqual({
      transferredOutMinor: 120_000,
      recoveredMinor: 25_000,
      stillOutMinor: 95_000,
    });
  });

  it('does not drag an unresolved reversal down with it', () => {
    // A limitation must not mask a real reason to call somebody.
    const { entry } = providerFinanceEntry(asProductionWrites(), {
      unresolvedCount: 1,
      reconciliationMismatch: false,
    });
    expect(entry.state).toBe('ATTENTION_REQUIRED');
  });
});
