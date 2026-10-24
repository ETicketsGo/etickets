import { feeLines } from '../fee-lines';
import { quoteSchema, type FeeBreakdown } from '../schema';

/** The QA quote for one Slow Coffee seat, 2026-10-24. */
const qaQuote = {
  fees: {
    currency: 'INR',
    subtotalMinor: 149900,
    discountMinor: 0,
    netSubtotalMinor: 149900,
    bookingFeeMinor: 2000,
    paymentFeeMinor: 3038,
    customerFeeMinor: 5038,
    organizerFeeMinor: 0,
    taxLines: [],
    taxMinor: 0,
    totalMinor: 154938,
  },
  coupon: { code: null, applied: false },
};

const fees = (over: Partial<FeeBreakdown> = {}): FeeBreakdown => ({
  ...quoteSchema.parse(qaQuote).fees,
  ...over,
});

describe('quote', () => {
  it('parses the real QA quote', () => {
    expect(quoteSchema.parse(qaQuote).fees.totalMinor).toBe(154938);
  });
});

describe('fee lines', () => {
  it('keeps the payment processing fee on its own line', () => {
    // Owner rule: never inside "Convenience fees".
    expect(feeLines(fees())).toEqual([
      { label: 'Convenience fees', minor: 2000 },
      { label: 'Payment processing fee', minor: 3038 },
    ]);
  });

  it('shows one total when the parts do not add up to what the buyer pays', () => {
    expect(feeLines(fees({ customerFeeMinor: 2000 }))).toEqual([{ label: 'Fees', minor: 2000 }]);
  });

  it('shows no fee line when the organizer absorbs every fee', () => {
    expect(feeLines(fees({ customerFeeMinor: 0 }))).toEqual([]);
  });

  it('shows a discount as a negative line and tax as its own line', () => {
    const lines = feeLines(fees({ discountMinor: 10000, taxMinor: 907 }));
    expect(lines[0]).toEqual({ label: 'Discount', minor: -10000 });
    expect(lines.at(-1)).toEqual({ label: 'Tax', minor: 907 });
  });
});
