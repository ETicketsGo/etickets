import {
  calculateCurrencySettlement,
  type CurrencySettlement,
  type CurrencySettlementInput,
  type SettlementRefundRow,
  type SettlementRevenueRow,
} from './currency-settlement.calculator';

/**
 * Proof that extracting the settlement arithmetic changed nothing.
 *
 * ── WHY AN ORACLE AND NOT EXPECTED VALUES ──────────────────────────────────────────
 * Hand-written expectations prove the new code matches what the AUTHOR BELIEVED the old code did.
 * That is the wrong claim for a refactor of the sum that decides what an organizer is paid: the
 * belief is exactly the thing that can be wrong.
 *
 * So the original implementation is reproduced below, verbatim, in the shape it had inside
 * `PayoutsService.settle()`, and every case asserts the WHOLE settlement object against it.
 * `toEqual` on the complete result means a one-minor-unit drift in any field fails, including a
 * field nobody thought to assert.
 */

/**
 * The arithmetic as it stood before extraction, transcribed from `PayoutsService.settle()`.
 *
 * Deliberately NOT refactored or tidied: its value here is being the old thing. It takes the
 * Prisma shapes the original worked on - `_sum` groups and refunds carrying their booking's
 * currency - so the transcription is honest rather than a paraphrase.
 */
function legacySettlementArithmetic(
  paid: { currency: string; _sum: Record<string, number | null> }[],
  refunds: { amountMinor: number; taxAddedMinor: number | null; booking: { currency: string } }[],
): CurrencySettlement[] {
  const refundByCurrency = new Map<string, number>();
  for (const row of refunds) {
    const currency = row.booking.currency.toUpperCase();
    const organizerShare = Math.max(0, row.amountMinor - (row.taxAddedMinor ?? 0));
    refundByCurrency.set(currency, (refundByCurrency.get(currency) ?? 0) + organizerShare);
  }
  const currencies = new Set([
    ...paid.map((row) => row.currency.toUpperCase()),
    ...refundByCurrency.keys(),
  ]);
  return [...currencies].sort().map((currency) => {
    const rows = paid.filter((row) => row.currency.toUpperCase() === currency);
    const sum = (key: string) => rows.reduce((total, row) => total + (row._sum[key] ?? 0), 0);
    const gross = sum('subtotalMinor');
    const discount = sum('discountMinor');
    const organizerFee = sum('organizerFeeMinor');
    const refund = refundByCurrency.get(currency) ?? 0;
    return {
      currency,
      gross,
      discount,
      bookingFee: sum('bookingFeeMinor'),
      paymentFee: sum('paymentFeeMinor'),
      organizerFee,
      refund,
      net: gross - discount - organizerFee - refund,
    };
  });
}

/** The same scenario in both shapes, so one description drives both implementations. */
function asLegacyInputs(input: CurrencySettlementInput) {
  return {
    paid: input.revenue.map((r) => ({
      currency: r.currency,
      _sum: {
        subtotalMinor: r.subtotalMinor,
        discountMinor: r.discountMinor,
        bookingFeeMinor: r.bookingFeeMinor,
        paymentFeeMinor: r.paymentFeeMinor,
        organizerFeeMinor: r.organizerFeeMinor,
      },
    })),
    refunds: input.refunds.map((r) => ({
      amountMinor: r.amountMinor,
      taxAddedMinor: r.taxAddedMinor,
      booking: { currency: r.currency },
    })),
  };
}

/** Assert the complete result, not selected fields. */
function expectIdenticalToLegacy(input: CurrencySettlementInput): CurrencySettlement[] {
  const legacyInputs = asLegacyInputs(input);
  const next = calculateCurrencySettlement(input);
  expect(next).toEqual(legacySettlementArithmetic(legacyInputs.paid, legacyInputs.refunds));
  return next;
}

const revenue = (
  over: Partial<SettlementRevenueRow> & { currency: string },
): SettlementRevenueRow => ({
  subtotalMinor: 0,
  discountMinor: 0,
  bookingFeeMinor: 0,
  paymentFeeMinor: 0,
  organizerFeeMinor: 0,
  ...over,
});
const refund = (
  currency: string,
  amountMinor: number,
  taxAddedMinor: number | null = 0,
): SettlementRefundRow => ({
  currency,
  amountMinor,
  taxAddedMinor,
});

describe('calculateCurrencySettlement — identical to the implementation it replaces', () => {
  const CASES: { name: string; input: CurrencySettlementInput }[] = [
    { name: 'nothing at all', input: { revenue: [], refunds: [] } },
    {
      name: 'gross only',
      input: { revenue: [revenue({ currency: 'INR', subtotalMinor: 100_000 })], refunds: [] },
    },
    {
      name: 'a zero-value settlement (a free event that still groups)',
      input: { revenue: [revenue({ currency: 'INR' })], refunds: [] },
    },
    {
      name: 'discounts, which come out of the organizer',
      input: {
        revenue: [revenue({ currency: 'INR', subtotalMinor: 100_000, discountMinor: 15_000 })],
        refunds: [],
      },
    },
    {
      name: 'booking and payment fees, which are reported and not deducted',
      input: {
        revenue: [
          revenue({
            currency: 'INR',
            subtotalMinor: 100_000,
            bookingFeeMinor: 5_000,
            paymentFeeMinor: 2_360,
          }),
        ],
        refunds: [],
      },
    },
    {
      name: 'the organizer fee, which is deducted',
      input: {
        revenue: [revenue({ currency: 'INR', subtotalMinor: 100_000, organizerFeeMinor: 7_500 })],
        refunds: [],
      },
    },
    {
      name: 'every money field at once',
      input: {
        revenue: [
          revenue({
            currency: 'INR',
            subtotalMinor: 250_000,
            discountMinor: 12_500,
            bookingFeeMinor: 8_000,
            paymentFeeMinor: 5_900,
            organizerFeeMinor: 18_750,
          }),
        ],
        refunds: [refund('INR', 30_000, 4_576)],
      },
    },
    {
      name: 'a refund carrying tax the platform remits',
      input: {
        revenue: [revenue({ currency: 'USD', subtotalMinor: 50_000 })],
        refunds: [refund('USD', 10_000, 900)],
      },
    },
    {
      name: 'an inclusive-tax market, where the whole refund is the organizer’s',
      input: {
        revenue: [revenue({ currency: 'INR', subtotalMinor: 50_000 })],
        refunds: [refund('INR', 10_000, 0)],
      },
    },
    {
      name: 'a refund with a null taxAdded',
      input: {
        revenue: [revenue({ currency: 'INR', subtotalMinor: 50_000 })],
        refunds: [refund('INR', 10_000, null)],
      },
    },
    {
      name: 'a refund recorded as more tax than money (a data fault, clamped)',
      input: {
        revenue: [revenue({ currency: 'INR', subtotalMinor: 50_000 })],
        refunds: [refund('INR', 1_000, 4_000)],
      },
    },
    {
      name: 'partial refunds across several orders',
      input: {
        revenue: [revenue({ currency: 'INR', subtotalMinor: 300_000, organizerFeeMinor: 15_000 })],
        refunds: [refund('INR', 25_000, 3_814), refund('INR', 10_000, 1_525), refund('INR', 1, 0)],
      },
    },
    {
      name: 'refunds and no revenue at all — the clawback case',
      input: { revenue: [], refunds: [refund('INR', 40_000, 0)] },
    },
    {
      name: 'refunds exceeding revenue, so net goes negative',
      input: {
        revenue: [revenue({ currency: 'INR', subtotalMinor: 10_000 })],
        refunds: [refund('INR', 75_000, 0)],
      },
    },
    {
      name: 'several currencies, which never mix',
      input: {
        revenue: [
          revenue({ currency: 'INR', subtotalMinor: 100_000, organizerFeeMinor: 5_000 }),
          revenue({ currency: 'USD', subtotalMinor: 20_000, organizerFeeMinor: 1_000 }),
          revenue({ currency: 'CAD', subtotalMinor: 7_000 }),
        ],
        refunds: [refund('USD', 2_500, 200), refund('CAD', 1_000, 0)],
      },
    },
    {
      name: 'the same currency grouped under different case',
      input: {
        revenue: [
          revenue({ currency: 'inr', subtotalMinor: 60_000 }),
          revenue({ currency: 'INR', subtotalMinor: 40_000 }),
        ],
        refunds: [refund('Inr', 5_000, 0)],
      },
    },
    {
      name: 'a currency present only in refunds alongside one present only in revenue',
      input: {
        revenue: [revenue({ currency: 'USD', subtotalMinor: 30_000 })],
        refunds: [refund('INR', 9_000, 0)],
      },
    },
    {
      name: 'one minor unit, the smallest money there is',
      input: { revenue: [revenue({ currency: 'INR', subtotalMinor: 1 })], refunds: [] },
    },
    {
      name: 'amounts past 2^31, which an Int column still holds in JS',
      input: {
        revenue: [revenue({ currency: 'INR', subtotalMinor: 2_147_483_647, organizerFeeMinor: 1 })],
        refunds: [],
      },
    },
  ];

  for (const { name, input } of CASES) {
    it(`matches the old arithmetic: ${name}`, () => {
      expectIdenticalToLegacy(input);
    });
  }

  it('matches the old arithmetic across 2000 randomised scenarios', () => {
    /*
      The named cases above are the ones somebody thought of. This is the one that catches what
      nobody did. Seeded, so a failure is reproducible rather than a story about a flaky test.
    */
    let seed = 20260930;
    const next = (bound: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % bound;
    };
    const codes = ['INR', 'inr', 'USD', 'CAD', 'cad', 'GBP'];

    for (let i = 0; i < 2000; i += 1) {
      const rev: SettlementRevenueRow[] = [];
      for (let r = next(4); r > 0; r -= 1) {
        rev.push(
          revenue({
            currency: codes[next(codes.length)],
            subtotalMinor: next(500_000),
            discountMinor: next(50_000),
            bookingFeeMinor: next(20_000),
            paymentFeeMinor: next(20_000),
            organizerFeeMinor: next(60_000),
          }),
        );
      }
      const refs: SettlementRefundRow[] = [];
      for (let r = next(5); r > 0; r -= 1) {
        refs.push(
          refund(codes[next(codes.length)], next(200_000), next(3) === 0 ? null : next(30_000)),
        );
      }
      expectIdenticalToLegacy({ revenue: rev, refunds: refs });
    }
  });
});

describe('calculateCurrencySettlement — the rules the numbers must obey', () => {
  it('never mixes two currencies into one total', () => {
    const out = calculateCurrencySettlement({
      revenue: [
        revenue({ currency: 'INR', subtotalMinor: 100_000 }),
        revenue({ currency: 'USD', subtotalMinor: 100_000 }),
      ],
      refunds: [refund('INR', 10_000, 0)],
    });
    expect(out.map((s) => s.currency)).toEqual(['INR', 'USD']);
    expect(out.find((s) => s.currency === 'INR')!.refund).toBe(10_000);
    // The USD row is untouched by the INR refund. Currency isolation, stated as an assertion.
    expect(out.find((s) => s.currency === 'USD')!.refund).toBe(0);
  });

  it('subtracts the organizer fee and leaves booking and payment fees alone', () => {
    /*
      `subtotalMinor` is the ticket face value net to the organizer; booking and payment fees are
      borne by the customer on top of it. The fee the organizer actually bears is
      `organizerFeeMinor`. The split is decided when the booking is written, so this sum needs no
      knowledge of FeeMode - which is why there is no FeeMode branch to test.
    */
    const [s] = calculateCurrencySettlement({
      revenue: [
        revenue({
          currency: 'INR',
          subtotalMinor: 100_000,
          discountMinor: 10_000,
          bookingFeeMinor: 9_999,
          paymentFeeMinor: 8_888,
          organizerFeeMinor: 5_000,
        }),
      ],
      refunds: [],
    });
    expect(s.net).toBe(100_000 - 10_000 - 5_000);
    expect(s.bookingFee).toBe(9_999);
    expect(s.paymentFee).toBe(8_888);
  });

  it('lets net go negative, because a clawback has to be recorded', () => {
    const [s] = calculateCurrencySettlement({
      revenue: [revenue({ currency: 'INR', subtotalMinor: 5_000 })],
      refunds: [refund('INR', 20_000, 0)],
    });
    expect(s.net).toBe(-15_000);
  });

  it('returns only integers, so no float can enter the ledger', () => {
    const out = calculateCurrencySettlement({
      revenue: [
        revenue({
          currency: 'INR',
          subtotalMinor: 333_333,
          discountMinor: 11_111,
          bookingFeeMinor: 7_777,
          paymentFeeMinor: 3_333,
          organizerFeeMinor: 9_999,
        }),
      ],
      refunds: [refund('INR', 12_345, 6_789)],
    });
    for (const s of out) {
      for (const [key, value] of Object.entries(s)) {
        if (key === 'currency') continue;
        expect(Number.isInteger(value as number)).toBe(true);
      }
    }
  });

  it('sorts by currency code, so two runs of the same data read the same', () => {
    const out = calculateCurrencySettlement({
      revenue: [
        revenue({ currency: 'USD', subtotalMinor: 1 }),
        revenue({ currency: 'CAD', subtotalMinor: 1 }),
        revenue({ currency: 'INR', subtotalMinor: 1 }),
      ],
      refunds: [],
    });
    expect(out.map((s) => s.currency)).toEqual(['CAD', 'INR', 'USD']);
  });

  it('does not decide eligibility — it settles every row it is given', () => {
    /*
      Which bookings belong in a settlement is the caller's query: the hold period, events a
      provider transfer has already claimed, revenue an earlier payout settled. If this function
      ever starts dropping rows, that separation has been lost.
    */
    const out = calculateCurrencySettlement({
      revenue: [revenue({ currency: 'INR', subtotalMinor: 0 })],
      refunds: [],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ currency: 'INR', gross: 0, net: 0 });
  });
});
