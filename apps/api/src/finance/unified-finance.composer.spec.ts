import { composeFinance, type ComposeInput } from './unified-finance.composer';
import { platformFinanceEntry, type PlatformAllocationRow } from './platform-finance.producer';
import { providerFinanceEntry } from './provider-finance.producer';

/**
 * Composition, tested against fixtures chosen so that a wrong formula produces a DIFFERENT number
 * from the right one.
 *
 * ── WHY THE NUMBERS LOOK AWKWARD ───────────────────────────────────────────────────
 * Every amount here is deliberately asymmetric and non-round. A fixture where entitlement happens
 * to equal holdings, or where the fee total happens to equal the deducted total, cannot fail when
 * the formula is wrong - the correct and incorrect answers coincide. That is not a hypothetical:
 * the provider producer's own lifecycle test was built with equal values, passed an injected
 * defect, and had to be rewritten.
 *
 * So each number below is distinct, and each falsification at the bottom changes the output.
 */

// ── the platform side ────────────────────────────────────────────────────────────────
const PLATFORM_ALLOCATIONS: PlatformAllocationRow[] = [
  {
    bookingId: 'bk-1',
    eventId: 'ev-platform',
    currency: 'INR',
    subtotalMinor: 91_400,
    discountMinor: 4_900,
    organizerFeeMinor: 2_700,
    refundShareMinor: 7_300,
    bookingFeeMinor: 1_300,
    paymentFeeMinor: 900,
    allocatedNetMinor: 76_500,
  },
  {
    bookingId: 'bk-2',
    eventId: 'ev-platform-2',
    currency: 'INR',
    subtotalMinor: 46_500,
    discountMinor: 2_400,
    organizerFeeMinor: 1_400,
    refundShareMinor: 4_400,
    bookingFeeMinor: 700,
    paymentFeeMinor: 500,
    allocatedNetMinor: 38_300,
  },
];

/** Derived from the allocations, so the fixture cannot disagree with itself by accident. */
const PLATFORM_PAYOUT = {
  id: 'payout-1',
  organizationId: 'org1',
  eventId: null,
  currency: 'INR',
  status: 'PAID',
  periodStart: null,
  periodEnd: new Date('2026-09-30T00:00:00Z'),
  grossMinor: 137_900, // 91 400 + 46 500
  bookingFeeMinor: 2_000, // 1 300 + 700   reported, NOT deducted
  paymentFeeMinor: 1_400, // 900 + 500     reported, NOT deducted
  refundMinor: 11_700, // 7 300 + 4 400
  netMinor: 114_800, // 137 900 - 7 300 - 4 100 - 11 700
  allocatedFrom: new Date('2026-09-30T00:00:00Z'),
};

// ── the provider side, every figure different from every platform figure ─────────────
const PROVIDER_SETTLEMENT = {
  id: 'settle-1',
  organizationId: 'org1',
  eventId: 'ev-provider',
  currency: 'inr',
  status: 'PARTIALLY_REFUNDED',
  grossSalesMinor: 83_250, // entitlement
  platformFeesMinor: 6_150, // deducted aggregate
  refundsMinor: 9_800, // accounting, NOT recovery
  disputesMinor: 0,
  reserveMinor: 0,
  releasedMinor: 71_000, // transferred out
  transferredMinor: 57_600, // still out  => recovered 13 400
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-30T00:00:00Z'),
};

const clean = { unresolvedCount: 0, reconciliationMismatch: false };

function mixed(): ComposeInput {
  return {
    platform: [platformFinanceEntry(PLATFORM_PAYOUT, PLATFORM_ALLOCATIONS)],
    provider: [providerFinanceEntry(PROVIDER_SETTLEMENT, clean)],
  };
}

describe('the fixture itself distinguishes right from wrong', () => {
  it('has no two concepts sharing a value', () => {
    /*
      Guarding the guard. If any of these coincided, a falsification below could pass while the
      formula was wrong. Asserted so a future edit cannot quietly make the suite toothless.
    */
    const values = [
      137_900, // platform gross
      114_800, // platform net / entitlement
      11_700, // platform refund
      2_000, // booking fee (reported)
      1_400, // payment fee (reported)
      4_100, // organizer fee (deducted)
      83_250, // provider entitlement
      71_000, // transferred out
      57_600, // still out
      13_400, // recovered
      9_800, // provider refunds accounting
      6_150, // provider fee aggregate
    ];
    expect(new Set(values).size).toBe(values.length);
  });

  it('builds a platform payout whose evidence agrees', () => {
    const { integrity } = platformFinanceEntry(PLATFORM_PAYOUT, PLATFORM_ALLOCATIONS);
    expect(integrity).toEqual([]);
  });
});

describe('a mixed organization', () => {
  it('keeps both paths without adding them into one revenue figure twice', () => {
    const { currencies } = composeFinance(mixed());
    expect(currencies).toHaveLength(1);
    const g = currencies[0];
    expect(g.currency).toBe('INR');
    expect(g.summary.counts).toEqual({ platform: 1, provider: 1 });

    // Entitlement is the sum of two DIFFERENT entitlements, each counted once.
    expect(g.summary.entitlementMinor).toBe(114_800 + 83_250);
    expect(g.summary.entitlementMinor).toBe(198_050);
    // Not the gross, which would be the classic double count against the provider side.
    expect(g.summary.entitlementMinor).not.toBe(137_900 + 83_250);
  });

  it('sums only the fees that actually came out of entitlement', () => {
    const { currencies } = composeFinance(mixed());
    // 4 100 organizer fee + 6 150 provider aggregate. NOT the 2 000 + 1 400 customer-borne.
    expect(currencies[0].summary.deductedFeesMinor).toBe(10_250);
    expect(currencies[0].summary.deductedFeesMinor).not.toBe(10_250 + 3_400);
  });

  it('reports movement from the provider side only', () => {
    const { currencies } = composeFinance(mixed());
    expect(currencies[0].summary.movement).toEqual({
      transferredOutMinor: 71_000,
      recoveredMinor: 13_400,
      stillOutMinor: 57_600,
    });
  });

  it('keeps refund accounting apart from recovered money', () => {
    const { currencies } = composeFinance(mixed());
    // Both figures present, and different. Conflating them would make one of them wrong.
    expect(currencies[0].summary.refundsMinor).toBe(11_700 + 9_800);
    expect(currencies[0].summary.movement!.recoveredMinor).toBe(13_400);
    expect(currencies[0].summary.refundsMinor).not.toBe(
      currencies[0].summary.movement!.recoveredMinor,
    );
  });

  it('splits entitlement by lifecycle without losing any of it', () => {
    const { currencies } = composeFinance(mixed());
    const s = currencies[0].summary;
    // The payout is PAID; the settlement is PARTIALLY_REFUNDED, which is neither paid nor pending.
    expect(s.paidMinor).toBe(114_800);
    expect(s.pendingMinor).toBe(0);
    expect(s.attentionMinor).toBe(83_250);
    expect(s.paidMinor + s.pendingMinor + s.attentionMinor).toBe(s.entitlementMinor);
  });
});

describe('a double claim is reported, not resolved', () => {
  it('names an event both paths claim', () => {
    const contested: ComposeInput = {
      platform: [
        platformFinanceEntry(
          { ...PLATFORM_PAYOUT, eventId: 'ev-contested' },
          PLATFORM_ALLOCATIONS.map((a) => ({ ...a, eventId: 'ev-contested' })),
        ),
      ],
      provider: [providerFinanceEntry({ ...PROVIDER_SETTLEMENT, eventId: 'ev-contested' }, clean)],
    };
    const g = composeFinance(contested).currencies[0];
    const doubles = g.warnings.filter((w) => w.code === 'DOUBLE_CLAIM');
    expect(doubles).toHaveLength(1);
    expect(doubles[0].category).toBe('FINANCIAL_INTEGRITY');
    expect(doubles[0].sourceIds).toEqual(['payout-1', 'settle-1']);
  });

  it('still returns both entries, because dropping either would hide real money', () => {
    const contested: ComposeInput = {
      platform: [
        platformFinanceEntry(
          { ...PLATFORM_PAYOUT, eventId: 'ev-contested' },
          PLATFORM_ALLOCATIONS.map((a) => ({ ...a, eventId: 'ev-contested' })),
        ),
      ],
      provider: [providerFinanceEntry({ ...PROVIDER_SETTLEMENT, eventId: 'ev-contested' }, clean)],
    };
    const g = composeFinance(contested).currencies[0];
    /*
      Dropping the platform entry would hide a payout that really was raised; dropping the provider
      entry would hide money that really moved. The conflict is the finding.
    */
    expect(g.entries).toHaveLength(2);
    expect(g.entries.map((e) => e.path)).toEqual(['PLATFORM', 'PROVIDER']);
  });

  it('does not cry wolf when the paths cover different events', () => {
    const g = composeFinance(mixed()).currencies[0];
    expect(g.warnings.filter((w) => w.code === 'DOUBLE_CLAIM')).toEqual([]);
  });

  it('cannot be fooled by a legacy payout, which claims no events at all', () => {
    /*
      A legacy period payout has UNKNOWN_LEGACY attribution, so it claims nothing - and therefore
      cannot produce a false double claim against a provider settlement. The correct treatment of
      its uncertainty is the warning below, not a fabricated overlap.
    */
    const g = composeFinance({
      platform: [
        platformFinanceEntry({ ...PLATFORM_PAYOUT, allocatedFrom: null, eventId: null }, []),
      ],
      provider: [providerFinanceEntry(PROVIDER_SETTLEMENT, clean)],
    }).currencies[0];
    expect(g.warnings.filter((w) => w.code === 'DOUBLE_CLAIM')).toEqual([]);
    expect(g.warnings.map((w) => w.code)).toContain('EVENT_ATTRIBUTION_UNAVAILABLE');
  });
});

describe('currency isolation is structural', () => {
  it('returns separate groups and no combined total', () => {
    const usd = {
      ...PROVIDER_SETTLEMENT,
      id: 'settle-usd',
      currency: 'USD',
      eventId: 'ev-usd',
      grossSalesMinor: 42_775,
      platformFeesMinor: 3_025,
      releasedMinor: 31_250,
      transferredMinor: 28_125,
      refundsMinor: 2_150,
    };
    const { currencies } = composeFinance({
      platform: [platformFinanceEntry(PLATFORM_PAYOUT, PLATFORM_ALLOCATIONS)],
      provider: [
        providerFinanceEntry(PROVIDER_SETTLEMENT, clean),
        providerFinanceEntry(usd, clean),
      ],
    });

    expect(currencies.map((c) => c.currency)).toEqual(['INR', 'USD']);
    expect(currencies[0].summary.entitlementMinor).toBe(198_050);
    expect(currencies[1].summary.entitlementMinor).toBe(42_775);
    // The combined figure appears nowhere.
    const serialized = JSON.stringify(currencies);
    expect(serialized).not.toContain(String(198_050 + 42_775));
  });

  it('has no field capable of holding a cross-currency total', () => {
    /*
      Structural, not a rule somebody has to remember: the only container is per currency, so
      INR + USD is unrepresentable rather than merely forbidden.
    */
    const result = composeFinance(mixed());
    expect(Object.keys(result)).toEqual(['currencies']);
  });

  it('folds case so one currency does not split into two groups', () => {
    const { currencies } = composeFinance({
      platform: [platformFinanceEntry(PLATFORM_PAYOUT, PLATFORM_ALLOCATIONS)],
      // Settlements store lower case; the payout stores upper.
      provider: [providerFinanceEntry(PROVIDER_SETTLEMENT, clean)],
    });
    expect(currencies).toHaveLength(1);
  });
});

describe('zero, absent and unknown stay distinguishable', () => {
  it('omits movement entirely for a platform-only organization', () => {
    const g = composeFinance({
      platform: [platformFinanceEntry(PLATFORM_PAYOUT, PLATFORM_ALLOCATIONS)],
      provider: [],
    }).currencies[0];
    // The platform ledger has no movement concept, so a zero would assert something about it.
    expect(g.summary.movement).toBeUndefined();
    expect(JSON.stringify(g.summary)).not.toContain('movement');
  });

  it('omits deducted fees when nothing proves one', () => {
    const g = composeFinance({
      platform: [platformFinanceEntry({ ...PLATFORM_PAYOUT, allocatedFrom: null }, [])],
      provider: [],
    }).currencies[0];
    // Legacy: no organizer fee was ever stored, so there is no deducted total to report.
    expect(g.summary.deductedFeesMinor).toBeUndefined();
  });

  it('separates the two legacy limitations, which are independent', () => {
    /*
      An event-scoped legacy payout knows its event and still cannot explain its deductions. So
      attribution and decomposition are reported separately - collapsing them into one
      "legacy=true" would lose a real distinction.
    */
    const eventScopedLegacy = composeFinance({
      platform: [
        platformFinanceEntry({ ...PLATFORM_PAYOUT, allocatedFrom: null, eventId: 'ev-known' }, []),
      ],
      provider: [],
    }).currencies[0];

    const codes = eventScopedLegacy.warnings.map((w) => w.code);
    expect(codes).toContain('DEDUCTION_DETAIL_UNAVAILABLE');
    // Attribution IS known here: the row names the event.
    expect(codes).not.toContain('EVENT_ATTRIBUTION_UNAVAILABLE');
  });

  it('reports a period legacy payout as both unknown attribution and unavailable detail', () => {
    const g = composeFinance({
      platform: [
        platformFinanceEntry({ ...PLATFORM_PAYOUT, allocatedFrom: null, eventId: null }, []),
      ],
      provider: [],
    }).currencies[0];
    const codes = g.warnings.map((w) => w.code).sort();
    expect(codes).toEqual(['DEDUCTION_DETAIL_UNAVAILABLE', 'EVENT_ATTRIBUTION_UNAVAILABLE']);
    // And its amount is still fully reported - the payout is real.
    expect(g.summary.entitlementMinor).toBe(114_800);
  });
});

describe('warnings are categorised so a history note is not an emergency', () => {
  it('marks a historical limitation as such', () => {
    const g = composeFinance({
      platform: [
        platformFinanceEntry({ ...PLATFORM_PAYOUT, allocatedFrom: null, eventId: null }, []),
      ],
      provider: [],
    }).currencies[0];
    expect(g.warnings.every((w) => w.category === 'HISTORICAL_LIMITATION')).toBe(true);
  });

  it('marks disagreeing evidence as a financial integrity problem', () => {
    const g = composeFinance({
      platform: [
        platformFinanceEntry({ ...PLATFORM_PAYOUT, grossMinor: 999 }, PLATFORM_ALLOCATIONS),
      ],
      provider: [],
    }).currencies[0];
    const integrity = g.warnings.filter((w) => w.category === 'FINANCIAL_INTEGRITY');
    expect(integrity.map((w) => w.code)).toContain('EVIDENCE_DISAGREEMENT');
  });

  it('reports an unresolved reversal as needing reconciliation, not as broken evidence', () => {
    const g = composeFinance({
      platform: [],
      provider: [
        providerFinanceEntry(PROVIDER_SETTLEMENT, {
          unresolvedCount: 1,
          reconciliationMismatch: false,
        }),
      ],
    }).currencies[0];
    const codes = g.warnings.map((w) => w.code);
    expect(codes).toContain('NEEDS_RECONCILIATION');
    expect(codes).not.toContain('EVIDENCE_DISAGREEMENT');
  });
});

describe('single-path organizations', () => {
  it('composes a platform-only organization', () => {
    const g = composeFinance({
      platform: [platformFinanceEntry(PLATFORM_PAYOUT, PLATFORM_ALLOCATIONS)],
      provider: [],
    }).currencies[0];
    expect(g.summary.counts).toEqual({ platform: 1, provider: 0 });
    expect(g.summary.entitlementMinor).toBe(114_800);
    expect(g.summary.deductedFeesMinor).toBe(4_100);
  });

  it('composes a provider-only organization', () => {
    const g = composeFinance({
      platform: [],
      provider: [providerFinanceEntry(PROVIDER_SETTLEMENT, clean)],
    }).currencies[0];
    expect(g.summary.counts).toEqual({ platform: 0, provider: 1 });
    expect(g.summary.entitlementMinor).toBe(83_250);
    expect(g.summary.movement!.recoveredMinor).toBe(13_400);
  });

  it('returns no groups at all for an organization with nothing', () => {
    // An honest empty result, distinguishable from a failure by the caller.
    expect(composeFinance({ platform: [], provider: [] }).currencies).toEqual([]);
  });
});

describe('lifecycle is never re-derived during composition', () => {
  it.each([
    ['REVERSED', 'ATTENTION_REQUIRED'],
    ['PARTIALLY_REFUNDED', 'PARTIALLY_REFUNDED'],
    ['TRANSFERRED', 'PAID'],
  ])('passes a %s settlement through as %s', (status, expected) => {
    const g = composeFinance({
      platform: [],
      provider: [providerFinanceEntry({ ...PROVIDER_SETTLEMENT, status }, clean)],
    }).currencies[0];
    expect(g.entries[0].entry.state).toBe(expected);
    expect(g.entries[0].entry.sourceStatus).toBe(status);
  });

  it('never counts a REVERSED settlement as paid', () => {
    const g = composeFinance({
      platform: [],
      provider: [
        providerFinanceEntry(
          { ...PROVIDER_SETTLEMENT, status: 'REVERSED', transferredMinor: 0 },
          clean,
        ),
      ],
    }).currencies[0];
    expect(g.summary.paidMinor).toBe(0);
    expect(g.summary.attentionMinor).toBe(83_250);
  });
});

/*
  ── PER-PATH SUBTOTALS ────────────────────────────────────────────────────────────────
  The organizer Finance page shows a platform ladder and needs the provider side beside it.
  Summing provider entries in a component would put a second financial opinion in the browser, so
  the server provides the split - using the same `buildSummary` as the total, which is what makes
  the parts add back to the whole by construction rather than by agreement.
*/
describe('per-path subtotals', () => {
  it('splits a mixed currency into its two routes', () => {
    const g = composeFinance(mixed()).currencies[0];
    expect(g.paths.map((p) => p.path)).toEqual(['PLATFORM', 'PROVIDER']);

    const platform = g.paths.find((p) => p.path === 'PLATFORM')!;
    const provider = g.paths.find((p) => p.path === 'PROVIDER')!;
    expect(platform.entitlementMinor).toBe(114_800);
    expect(provider.entitlementMinor).toBe(83_250);
    // Each counted once, in its own route.
    expect(platform.counts).toEqual({ platform: 1, provider: 0 });
    expect(provider.counts).toEqual({ platform: 0, provider: 1 });
  });

  it('adds back to the combined total, exactly', () => {
    /*
      THE INVARIANT. If the parts could disagree with the whole, a screen showing both would
      display two numbers that cannot both be right - and nobody would know which.
    */
    const g = composeFinance(mixed()).currencies[0];
    const sum = (k: 'entitlementMinor' | 'paidMinor' | 'pendingMinor' | 'attentionMinor') =>
      g.paths.reduce((t, p) => t + p[k], 0);

    expect(sum('entitlementMinor')).toBe(g.summary.entitlementMinor);
    expect(sum('paidMinor')).toBe(g.summary.paidMinor);
    expect(sum('pendingMinor')).toBe(g.summary.pendingMinor);
    expect(sum('attentionMinor')).toBe(g.summary.attentionMinor);
  });

  it('attributes movement to the provider route only', () => {
    const g = composeFinance(mixed()).currencies[0];
    const platform = g.paths.find((p) => p.path === 'PLATFORM')!;
    const provider = g.paths.find((p) => p.path === 'PROVIDER')!;
    // The platform ledger has no movement concept, so it reports none rather than zeroes.
    expect(platform.movement).toBeUndefined();
    expect(provider.movement).toEqual({
      transferredOutMinor: 71_000,
      recoveredMinor: 13_400,
      stillOutMinor: 57_600,
    });
  });

  it('keeps the deducted-fee split per route', () => {
    const g = composeFinance(mixed()).currencies[0];
    // 4 100 organizer fee against 6 150 provider aggregate - different routes, different fees.
    expect(g.paths.find((p) => p.path === 'PLATFORM')!.deductedFeesMinor).toBe(4_100);
    expect(g.paths.find((p) => p.path === 'PROVIDER')!.deductedFeesMinor).toBe(6_150);
    expect(g.summary.deductedFeesMinor).toBe(10_250);
  });

  it('lists only the routes an organization actually uses', () => {
    /*
      A platform-only organization gets ONE path, not two with a zeroed provider. A zero would
      assert something about a settlement route this organization does not use at all.
    */
    const platformOnly = composeFinance({
      platform: [platformFinanceEntry(PLATFORM_PAYOUT, PLATFORM_ALLOCATIONS)],
      provider: [],
    }).currencies[0];
    expect(platformOnly.paths.map((p) => p.path)).toEqual(['PLATFORM']);

    const providerOnly = composeFinance({
      platform: [],
      provider: [providerFinanceEntry(PROVIDER_SETTLEMENT, clean)],
    }).currencies[0];
    expect(providerOnly.paths.map((p) => p.path)).toEqual(['PROVIDER']);
  });

  it('still holds no cross-currency total through the path split', () => {
    const usd = {
      ...PROVIDER_SETTLEMENT,
      id: 'settle-usd2',
      currency: 'USD',
      eventId: 'ev-usd2',
      grossSalesMinor: 42_775,
      releasedMinor: 31_250,
      transferredMinor: 28_125,
    };
    const result = composeFinance({
      platform: [platformFinanceEntry(PLATFORM_PAYOUT, PLATFORM_ALLOCATIONS)],
      provider: [
        providerFinanceEntry(PROVIDER_SETTLEMENT, clean),
        providerFinanceEntry(usd, clean),
      ],
    });
    // Each currency's paths belong to that currency only.
    const inr = result.currencies.find((c) => c.currency === 'INR')!;
    const usdGroup = result.currencies.find((c) => c.currency === 'USD')!;
    expect(inr.paths.find((p) => p.path === 'PROVIDER')!.entitlementMinor).toBe(83_250);
    expect(usdGroup.paths.find((p) => p.path === 'PROVIDER')!.entitlementMinor).toBe(42_775);
    expect(JSON.stringify(result)).not.toContain(String(83_250 + 42_775));
  });
});
