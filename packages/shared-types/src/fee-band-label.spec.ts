import { describe, expect, it } from 'vitest';
import { feeBandLabel } from './fee-band-label';

describe('feeBandLabel', () => {
  it('writes an INR band in whole rupees', () => {
    expect(feeBandLabel({ minMinor: 0, maxMinor: 49_900 }, 'INR')).toBe('Tickets ₹0 - ₹499');
  });

  it('shows paise only when a boundary has them', () => {
    expect(feeBandLabel({ minMinor: 20_000, maxMinor: 49_950 }, 'INR')).toBe(
      'Tickets ₹200 - ₹499.50',
    );
  });

  it('groups INR thousands the Indian way', () => {
    expect(feeBandLabel({ minMinor: 10_000_000, maxMinor: null }, 'INR')).toBe(
      'Tickets ₹1,00,000 and above',
    );
  });

  it('writes a USD band with cents', () => {
    expect(feeBandLabel({ minMinor: 1_000, maxMinor: 2_499 }, 'USD')).toBe(
      'Tickets $10.00 - $24.99',
    );
  });

  it('writes an open-ended band as "and above"', () => {
    expect(feeBandLabel({ minMinor: 5_000, maxMinor: null }, 'USD')).toBe(
      'Tickets $50.00 and above',
    );
  });

  it('follows the boundaries, so an edited band is renamed', () => {
    const before = feeBandLabel({ minMinor: 0, maxMinor: 999 }, 'USD');
    const after = feeBandLabel({ minMinor: 0, maxMinor: 1_499 }, 'USD');
    expect(before).toBe('Tickets $0.00 - $9.99');
    expect(after).toBe('Tickets $0.00 - $14.99');
  });

  it('uses only ASCII apart from the currency sign', () => {
    const label = feeBandLabel({ minMinor: 0, maxMinor: 19_900 }, 'INR').replace('₹', '');
    expect(/^[\x20-\x7e]*$/.test(label.replace('₹', ''))).toBe(true);
  });
});
