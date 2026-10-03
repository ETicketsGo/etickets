import { describe, it, expect } from 'vitest';
import { financeView, splitFees, type FinanceLoad } from './finance-view';
import type { FinanceCurrencyGroupDto, UnifiedFinanceDto } from '@eticketsgo/web-kit';

/**
 * The three situations a money page must never confuse, tested at the rendering boundary.
 *
 *   UNAVAILABLE   the request failed
 *   NO_RECORDS    it succeeded and there is nothing yet
 *   RECORDS       there are records, one of which may legitimately be zero
 *
 * A zero is a fact about money. The other two are not facts about money at all, and rendering
 * either as a currency figure tells an organizer something false.
 */

const group = (over: Partial<FinanceCurrencyGroupDto> = {}): FinanceCurrencyGroupDto => ({
  currency: 'INR',
  entries: [],
  summary: {
    entitlementMinor: 114_800,
    paidMinor: 114_800,
    pendingMinor: 0,
    attentionMinor: 0,
    counts: { platform: 1, provider: 0 },
  },
  warnings: [],
  ...over,
});

const loaded = (data: UnifiedFinanceDto): FinanceLoad => ({ kind: 'LOADED', data });

describe('failure, empty and a real zero are three different screens', () => {
  it('shows no figure at all when the request failed', () => {
    const v = financeView({ kind: 'FAILED', reason: 'network' });
    expect(v.kind).toBe('UNAVAILABLE');
    expect(v.amountsShown).toBe(false);
    expect(v.currencies).toEqual([]);
    // It says the money did not change, because a failed read is not a financial event.
    expect(v.explanation).toMatch(/problem at our end/i);
  });

  it('shows no figure when there are genuinely no records', () => {
    const v = financeView(loaded({ currencies: [] }));
    expect(v.kind).toBe('NO_RECORDS');
    expect(v.amountsShown).toBe(false);
    expect(v.currencies).toEqual([]);
  });

  it('shows a real zero as a figure, because that one IS a fact', () => {
    const v = financeView(
      loaded({
        currencies: [
          group({
            summary: {
              entitlementMinor: 0,
              paidMinor: 0,
              pendingMinor: 0,
              attentionMinor: 0,
              counts: { platform: 1, provider: 0 },
            },
          }),
        ],
      }),
    );
    expect(v.kind).toBe('RECORDS');
    expect(v.amountsShown).toBe(true);
    expect(v.currencies[0].entitlementMinor).toBe(0);
  });

  it('gives the three situations three different kinds and headings', () => {
    /*
      The property, stated directly. If any two of these collapsed, a screen could not tell them
      apart no matter how carefully it was written.
    */
    const failed = financeView({ kind: 'FAILED' });
    const empty = financeView(loaded({ currencies: [] }));
    const zero = financeView(
      loaded({
        currencies: [
          group({
            summary: {
              entitlementMinor: 0,
              paidMinor: 0,
              pendingMinor: 0,
              attentionMinor: 0,
              counts: { platform: 1, provider: 0 },
            },
          }),
        ],
      }),
    );

    expect(new Set([failed.kind, empty.kind, zero.kind]).size).toBe(3);
    expect(new Set([failed.heading, empty.heading, zero.heading]).size).toBe(3);
    // And only the one backed by a record may show money.
    expect([failed.amountsShown, empty.amountsShown, zero.amountsShown]).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('distinguishes loading from failure', () => {
    const v = financeView({ kind: 'LOADING' });
    expect(v.kind).toBe('LOADING');
    expect(v.amountsShown).toBe(false);
    expect(v.kind).not.toBe('UNAVAILABLE');
  });
});

describe('absent is null, never zero', () => {
  it('reports an omitted deducted-fee total as null', () => {
    /*
      The server omits this when no record in the currency proves a deducted fee - a legacy payout
      never stored its organizer fee. A 0 here would be the UI inventing a fact the server
      declined to state.
    */
    const v = financeView(loaded({ currencies: [group()] }));
    expect(v.currencies[0].deductedFeesMinor).toBeNull();
    expect(v.currencies[0].refundsMinor).toBeNull();
    expect(v.currencies[0].movement).toBeNull();
  });

  it('reports a proven zero as zero', () => {
    const v = financeView(
      loaded({
        currencies: [
          group({
            summary: {
              entitlementMinor: 50_000,
              paidMinor: 50_000,
              pendingMinor: 0,
              attentionMinor: 0,
              deductedFeesMinor: 0,
              refundsMinor: 0,
              counts: { platform: 1, provider: 0 },
            },
          }),
        ],
      }),
    );
    // Zero and null are different, and both reach the view intact.
    expect(v.currencies[0].deductedFeesMinor).toBe(0);
    expect(v.currencies[0].refundsMinor).toBe(0);
  });

  it('passes movement through only where the path reports it', () => {
    const v = financeView(
      loaded({
        currencies: [
          group({
            summary: {
              entitlementMinor: 83_250,
              paidMinor: 0,
              pendingMinor: 0,
              attentionMinor: 83_250,
              movement: {
                transferredOutMinor: 71_000,
                recoveredMinor: 13_400,
                stillOutMinor: 57_600,
              },
              counts: { platform: 0, provider: 1 },
            },
          }),
        ],
      }),
    );
    expect(v.currencies[0].movement).toEqual({
      transferredOutMinor: 71_000,
      recoveredMinor: 13_400,
      stillOutMinor: 57_600,
    });
    // Entitlement is not any of those three.
    expect(v.currencies[0].entitlementMinor).toBe(83_250);
  });
});

describe('currencies stay separate', () => {
  it('renders one section per currency with no combined figure', () => {
    const v = financeView(
      loaded({
        currencies: [
          group({ currency: 'INR' }),
          group({
            currency: 'USD',
            summary: {
              entitlementMinor: 42_775,
              paidMinor: 42_775,
              pendingMinor: 0,
              attentionMinor: 0,
              counts: { platform: 0, provider: 1 },
            },
          }),
        ],
      }),
    );
    expect(v.currencies.map((c) => c.currency)).toEqual(['INR', 'USD']);
    // No field anywhere holds the sum of the two.
    expect(JSON.stringify(v)).not.toContain(String(114_800 + 42_775));
  });
});

describe('warnings become organizer language, with the right weight', () => {
  const withWarning = (
    category: 'HISTORICAL_LIMITATION' | 'FINANCIAL_INTEGRITY',
    code: Parameters<typeof financeView> extends never ? never : string,
  ) =>
    financeView(
      loaded({
        currencies: [
          group({
            warnings: [
              {
                category,
                code: code as never,
                sourceIds: ['p1'],
                detail: 'internal detail',
              },
            ],
          }),
        ],
      }),
    );

  it('treats a historical gap as information, not an emergency', () => {
    const v = withWarning('HISTORICAL_LIMITATION', 'EVENT_ATTRIBUTION_UNAVAILABLE');
    expect(v.currencies[0].notices[0].tone).toBe('info');
    expect(v.currencies[0].notices[0].message).toMatch(/older payouts/i);
  });

  it('treats disagreeing evidence as needing attention', () => {
    const v = withWarning('FINANCIAL_INTEGRITY', 'EVIDENCE_DISAGREEMENT');
    expect(v.currencies[0].notices[0].tone).toBe('attention');
    // And it says nothing was changed, because nothing was.
    expect(v.currencies[0].notices[0].message).toMatch(/nothing has been changed/i);
  });

  it('never shows our internal vocabulary to an organizer', () => {
    for (const code of [
      'EVENT_ATTRIBUTION_UNAVAILABLE',
      'DEDUCTION_DETAIL_UNAVAILABLE',
      'EVIDENCE_DISAGREEMENT',
      'DOUBLE_CLAIM',
      'NEEDS_RECONCILIATION',
    ]) {
      const v = withWarning('HISTORICAL_LIMITATION', code);
      const message = v.currencies[0].notices[0].message;
      for (const leak of [
        'UNKNOWN_LEGACY',
        'ATTENTION_REQUIRED',
        'PayoutAllocation',
        'allocatedFrom',
        code,
      ]) {
        expect(message).not.toContain(leak);
      }
      // And it is a sentence, not a token.
      expect(message).toMatch(/[a-z] [a-z]/);
    }
  });

  it('says the amounts are correct when only the breakdown is missing', () => {
    /*
      The distinction a legacy payout needs. The money is authoritative; only its decomposition is
      gone. Telling an organizer the figure is unreliable would be worse than saying nothing.
    */
    const v = withWarning('HISTORICAL_LIMITATION', 'DEDUCTION_DETAIL_UNAVAILABLE');
    expect(v.currencies[0].notices[0].message).toMatch(/amounts paid are correct/i);
  });
});

describe('fee lines are split, never summed', () => {
  const fees = [
    { key: 'PLATFORM', amountMinor: 1_000, deducted: true },
    { key: 'BOOKING', amountMinor: 3_000, deducted: false },
    { key: 'PAYMENT_PROCESSING', amountMinor: 2_000, deducted: false },
  ];

  it('totals only what actually came out: 1 000, not 6 000', () => {
    const split = splitFees(fees);
    expect(split.deductedTotalMinor).toBe(1_000);
    expect(fees.reduce((t, f) => t + f.amountMinor, 0)).toBe(6_000);
    expect(split.deducted.map((f) => f.key)).toEqual(['PLATFORM']);
    expect(split.reported.map((f) => f.key)).toEqual(['BOOKING', 'PAYMENT_PROCESSING']);
  });

  it('handles an entry with no fee lines without inventing a total', () => {
    const split = splitFees(undefined);
    expect(split.deducted).toEqual([]);
    expect(split.reported).toEqual([]);
    // Zero here is the sum of nothing, which is honest; the absence is carried by the empty lists.
    expect(split.deductedTotalMinor).toBe(0);
  });
});
