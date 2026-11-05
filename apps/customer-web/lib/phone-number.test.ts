import { describe, expect, it } from 'vitest';
import { phoneCountryGuess, readTypedNumber, toE164 } from './phone-number';

describe('phoneCountryGuess: where the visitor is, never a hard-coded default', () => {
  it('prefers the location the platform resolved over the browser', () => {
    // A US-English laptop in Bengaluru: the network says India, the browser says nothing useful.
    expect(phoneCountryGuess('IN', 'US')).toBe('IN');
  });

  it('falls back to the browser when the location is unknown', () => {
    expect(phoneCountryGuess(null, 'US')).toBe('US');
    expect(phoneCountryGuess(undefined, 'ca')).toBe('CA');
  });

  it('skips a country we cannot dial, rather than returning it', () => {
    expect(phoneCountryGuess('DE', 'GB')).toBe('GB');
  });

  it('answers null - an empty select - when nothing places the visitor', () => {
    // Never India, never the United States: guessing is how a code reached a stranger.
    expect(phoneCountryGuess(null, null)).toBeNull();
    expect(phoneCountryGuess('DE', 'FR')).toBeNull();
  });
});

describe('readTypedNumber', () => {
  it('takes the country out of a pasted international number', () => {
    expect(readTypedNumber('+1 415 555 0132')).toEqual({ country: 'US', national: '4155550132' });
    expect(readTypedNumber('0091 09704 464007')).toEqual({
      country: 'IN',
      national: '9704464007',
    });
  });

  it('reads a pasted +1 as the United States, unless Canada was already chosen', () => {
    expect(readTypedNumber('+14155550132').country).toBe('US');
    expect(readTypedNumber('+14165550132', 'CA').country).toBe('CA');
    // A choice that does not match the pasted code does not stick.
    expect(readTypedNumber('+14155550132', 'IN').country).toBe('US');
  });

  it('reads the longest calling code first', () => {
    expect(readTypedNumber('+971501234567').country).toBe('AE');
  });

  it('keeps a national number national and drops the trunk zero', () => {
    expect(readTypedNumber('097044 64007')).toEqual({ national: '9704464007' });
  });
});

describe('toE164', () => {
  it('joins the country and the national part', () => {
    expect(toE164('US', '4155550132')).toBe('+14155550132');
  });
  it('is empty until both halves exist', () => {
    expect(toE164('', '4155550132')).toBe('');
    expect(toE164('IN', '')).toBe('');
  });
});

describe('one number, however it is typed (phone identity)', () => {
  it('+91 98765 43210, 09876543210 with India chosen, and +919876543210 are one E.164 number', () => {
    const typed = ['+91 98765 43210', '09876543210', '+919876543210', '0091 98765 43210'];
    const e164 = typed.map((t) => {
      const read = readTypedNumber(t, 'IN');
      return toE164(read.country ?? 'IN', read.national);
    });
    expect(new Set(e164)).toEqual(new Set(['+919876543210']));
  });
});
