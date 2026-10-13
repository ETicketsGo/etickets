import { describe, expect, it } from 'vitest';
import { describeDiscrepancy } from './discrepancy-detail';

describe('describeDiscrepancy', () => {
  it('formats minor units in the row currency, with Indian grouping for rupees', () => {
    const out = describeDiscrepancy('Amount differs: internal 12345600 vs provider 0.', 'INR');
    expect(out).toContain('₹1,23,456');
    expect(out).not.toContain('12345600');
  });

  it('formats dollars with dollar grouping', () => {
    expect(describeDiscrepancy('Amount differs: internal 165036 vs provider 0.', 'USD')).toContain(
      '$1,650.36',
    );
  });

  it('turns enum names into words, with no quoted constants', () => {
    const out = describeDiscrepancy(
      "Provider status is 'CANCELLED' but internal is SUCCEEDED.",
      'INR',
    );
    expect(out).toBe('The provider shows this payment as cancelled, but we have it as paid.');
  });

  it('names both currencies of a currency mismatch', () => {
    expect(describeDiscrepancy('Currency differs: internal INR vs provider USD.', 'INR')).toContain(
      'in INR, but the provider recorded USD',
    );
  });

  it('never guesses a currency: an amount with no known currency stays as stored', () => {
    const raw = 'Refund 15000 exceeds captured 10000.';
    expect(describeDiscrepancy(raw, null)).toBe(raw);
  });

  it('leaves an unrecognised sentence unchanged', () => {
    expect(describeDiscrepancy('Something new happened.', 'INR')).toBe('Something new happened.');
  });
});
