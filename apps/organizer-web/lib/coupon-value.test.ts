import { describe, expect, it } from 'vitest';
import {
  couponCurrency,
  couponValueError,
  couponValueToApi,
  couponValueToInput,
} from './coupon-value';

/**
 * A fixed discount is stored in minor units. The promotions form used to send the typed
 * rupees as they were, so a code created as ₹100 off took ₹1 off every booking. These pin the
 * conversion in both directions and the validation in front of it, and pin percentages as
 * unchanged.
 */
describe('a fixed discount', () => {
  it('is sent in minor units', () => {
    expect(couponValueToApi('FIXED', '100')).toBe(10_000);
    expect(couponValueToApi('FIXED', '49.99')).toBe(4_999);
    // 0.29 * 100 is 28.999999999999996 in floating point; the stored value must still be 29.
    expect(couponValueToApi('FIXED', '0.29')).toBe(29);
  });

  it('is shown in major units when edited, and survives the round trip', () => {
    expect(couponValueToInput('FIXED', 10_000)).toBe('100');
    expect(couponValueToInput('FIXED', 4_999)).toBe('49.99');
    expect(couponValueToApi('FIXED', couponValueToInput('FIXED', 4_999))).toBe(4_999);
  });

  it('accepts decimals, and refuses more precision than the currency has', () => {
    expect(couponValueError('FIXED', '49.99')).toBeNull();
    expect(couponValueError('FIXED', '0.29')).toBeNull();
    expect(couponValueError('FIXED', '10.005')).toMatch(/two decimal/);
  });

  it('refuses nothing, zero, negatives and non-numbers', () => {
    for (const input of ['', '0', '-5', 'abc']) {
      expect(couponValueError('FIXED', input)).not.toBeNull();
    }
  });
});

describe('a percentage discount', () => {
  it('is sent and shown unchanged', () => {
    expect(couponValueToApi('PERCENT', '15')).toBe(15);
    expect(couponValueToInput('PERCENT', 15)).toBe('15');
  });

  it('is a whole number from 1 to 100', () => {
    expect(couponValueError('PERCENT', '1')).toBeNull();
    expect(couponValueError('PERCENT', '100')).toBeNull();
    expect(couponValueError('PERCENT', '12.5')).not.toBeNull();
    expect(couponValueError('PERCENT', '0')).not.toBeNull();
    expect(couponValueError('PERCENT', '101')).toMatch(/1–100/);
  });
});

describe('the currency a fixed amount is labelled in', () => {
  it('is the one the venues sell in', () => {
    expect(couponCurrency(['USD', 'USD'])).toEqual({ currency: 'USD', mixed: false });
  });

  it('is the most common when the venues sell in several, and says so', () => {
    expect(couponCurrency(['CAD', 'USD', 'USD'])).toEqual({ currency: 'USD', mixed: true });
  });

  it('ignores venues whose country has no known currency', () => {
    expect(couponCurrency([null, 'CAD', undefined])).toEqual({ currency: 'CAD', mixed: false });
  });

  it('falls back to INR before there is a venue', () => {
    expect(couponCurrency([])).toEqual({ currency: 'INR', mixed: false });
  });
});
