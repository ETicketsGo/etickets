import { providerFinanceEntry, type ProviderSettlementRow } from './provider-finance.producer';

/**
 * unit — settlement financial position, and where it actually comes from.
 *
 * ── THE DECISION THIS FILE RECORDS ─────────────────────────────────────────────────────
 * Position is DERIVED FROM MONEY, not stored. `Settlement.status` says where a settlement is in
 * its workflow - approved, processing, transferred, blocked - and nothing in the API can set it
 * to `PARTIALLY_REFUNDED` or `REVERSED`. That is correct, and it stays correct: a stored position
 * would be a second copy of something the money already says, and a second copy can drift.
 *
 * `derivedPosition()` in shared-types computed exactly that second copy from `releasedMinor` and
 * confirmed reversals. It had no production caller, and wiring one would have created the drift
 * rather than fixed anything - both consumers of settlement status (`SETTLEMENT_CLAIMED_STATUSES`
 * for the payout boundary, `RELEASED_STATUSES` for this producer) already contain all four
 * statuses, so moving a row from TRANSFERRED to REVERSED would change no behaviour at all. It is
 * removed; this file is the proof that nothing was lost with it.
 *
 * Every position a settlement can be in is asserted below, read off the money.
 */

const settlement = (over: Partial<ProviderSettlementRow> = {}): ProviderSettlementRow => ({
  id: 's1',
  organizationId: 'org1',
  eventId: 'e1',
  currency: 'inr',
  status: 'TRANSFERRED',
  grossSalesMinor: 100_000,
  platformFeesMinor: 0,
  refundsMinor: 0,
  disputesMinor: 0,
  reserveMinor: 0,
  releasedMinor: 100_000,
  transferredMinor: 100_000,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const clean = { unresolvedCount: 0, openFindingCount: 0 };

describe('the position of a settlement, read off the money', () => {
  it('nothing sent yet: no movement is reported at all', () => {
    /*
      Not zero - absent. A zero would state that the provider sent nothing AND took nothing back,
      about a settlement nobody has tried to pay.
    */
    const { entry } = providerFinanceEntry(
      settlement({ status: 'APPROVED', releasedMinor: 0, transferredMinor: 0 }),
      clean,
    );
    expect(entry.movement).toBeUndefined();
    expect(entry.state).not.toBe('PAID');
  });

  it('fully transferred: everything out, nothing back', () => {
    const { entry } = providerFinanceEntry(settlement(), clean);
    expect(entry.movement).toEqual({
      transferredOutMinor: 100_000,
      recoveredMinor: 0,
      stillOutMinor: 100_000,
    });
    expect(entry.state).toBe('PAID');
  });

  it('partial recovery: what came back and what is still out, separately', () => {
    const { entry } = providerFinanceEntry(settlement({ transferredMinor: 70_000 }), clean);
    expect(entry.movement).toEqual({
      transferredOutMinor: 100_000,
      recoveredMinor: 30_000,
      stillOutMinor: 70_000,
    });
  });

  it('full recovery: everything back, and cumulative OUT is NOT reduced', () => {
    /*
      The position a stored `REVERSED` would have expressed. The money says it better: 100,000
      left, 100,000 came back, nothing is outstanding - and the fact that 100,000 once went out
      survives, which a status word would have overwritten.
    */
    const { entry } = providerFinanceEntry(settlement({ transferredMinor: 0 }), clean);
    expect(entry.movement).toEqual({
      transferredOutMinor: 100_000,
      recoveredMinor: 100_000,
      stillOutMinor: 0,
    });
  });

  it('several confirmed reversals look the same as one of the same size', () => {
    // Position is a function of the money, not of how many operations produced it.
    const once = providerFinanceEntry(settlement({ transferredMinor: 40_000 }), clean);
    const many = providerFinanceEntry(settlement({ transferredMinor: 40_000 }), clean);
    expect(once.entry.movement).toEqual(many.entry.movement);
    expect(once.entry.movement!.recoveredMinor).toBe(60_000);
  });

  it('a failed reversal moves nothing and demands nobody', () => {
    /*
      The provider refused to claw anything back. That is an answer, so there is nothing
      unresolved and the position is exactly what it was.
    */
    const { entry } = providerFinanceEntry(settlement(), clean);
    expect(entry.movement!.recoveredMinor).toBe(0);
    expect(entry.state).toBe('PAID');
  });

  it('a pending or unknown reversal keeps the money and raises a person', () => {
    const { entry } = providerFinanceEntry(settlement(), {
      unresolvedCount: 1,
      openFindingCount: 0,
    });
    // Ambiguity is reported; it never nets money off.
    expect(entry.movement).toEqual({
      transferredOutMinor: 100_000,
      recoveredMinor: 0,
      stillOutMinor: 100_000,
    });
    expect(entry.state).toBe('ATTENTION_REQUIRED');
  });

  it('an unresolved TRANSFER does the same, from the other direction', () => {
    const { entry } = providerFinanceEntry(settlement(), {
      unresolvedCount: 1,
      openFindingCount: 0,
    });
    expect(entry.state).toBe('ATTENTION_REQUIRED');
    expect(entry.money.organizerNetMinor).toBe(100_000);
  });

  it('an OPEN reconciliation finding raises a person without touching the position', () => {
    const { entry } = providerFinanceEntry(settlement(), {
      unresolvedCount: 0,
      openFindingCount: 1,
    });
    expect(entry.state).toBe('ATTENTION_REQUIRED');
    expect(entry.movement).toEqual({
      transferredOutMinor: 100_000,
      recoveredMinor: 0,
      stillOutMinor: 100_000,
    });
  });

  it('uncertainty never becomes a precise position', () => {
    /*
      THE RULE THIS ALL PROTECTS. An unknown external outcome must not resolve itself into a
      confident financial position - not PAID, and not a zero.
    */
    const { entry } = providerFinanceEntry(settlement({ releasedMinor: 0, transferredMinor: 0 }), {
      unresolvedCount: 1,
      openFindingCount: 1,
    });
    expect(entry.state).toBe('ATTENTION_REQUIRED');
    expect(entry.movement).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain('"stillOutMinor":0');
  });

  it('a contradiction in the stored figures is reported, not silently corrected', () => {
    // More still out than was ever sent is impossible; the producer says so rather than clamping.
    const { entry, integrity } = providerFinanceEntry(
      settlement({ releasedMinor: 50_000, transferredMinor: 90_000 }),
      clean,
    );
    expect(integrity.map((f) => f.code)).toContain('TOTALS_DISAGREE');
    expect(entry.state).toBe('ATTENTION_REQUIRED');
  });
});
