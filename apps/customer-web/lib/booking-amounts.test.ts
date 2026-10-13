import { describe, expect, it } from 'vitest';
import { moneyFractionDigits } from '@eticketsgo/web-kit';
import { bookingAmounts } from './booking-amounts';

// The seated film on QA: two seats at 150.00 = 300.00, all of it whole rupees, with GST of 45.76
// inside the price. Payment printed 300.00 / 45.76; the confirmation printed 300 / 46.
const SEATED = {
  items: [{ unitPriceMinor: 15000, quantity: 2 }],
  subtotalMinor: 30000,
  discountMinor: 0,
  bookingFeeMinor: 0,
  paymentFeeMinor: 0,
  taxLines: [{ amountMinor: 4576 }],
  totalMinor: 30000,
};

describe('one number of decimals for a booking', () => {
  it('counts the GST paise, so a whole-rupee order prints 300.00 and 45.76', () => {
    expect(moneyFractionDigits(bookingAmounts(SEATED), 'INR')).toBe(2);
  });

  it('is what the lines alone would get wrong', () => {
    const linesOnly = [30000, 30000];
    expect(moneyFractionDigits(linesOnly, 'INR')).toBe(0);
  });

  it('stays whole when every amount is whole', () => {
    expect(
      moneyFractionDigits(bookingAmounts({ ...SEATED, taxLines: [{ amountMinor: 4600 }] }), 'INR'),
    ).toBe(0);
  });
});
