import { phoneCountryGuess, readTypedNumber, toE164 } from '../phone-number';

describe('reading a phone number like the storefront', () => {
  it('never assumes a country: unknown places give no guess', () => {
    expect(phoneCountryGuess(null, undefined)).toBeNull();
    expect(phoneCountryGuess('BR', 'DE')).toBeNull();
  });

  it('prefers where the server located the person, then the phone region', () => {
    expect(phoneCountryGuess('us', 'IN')).toBe('US');
    expect(phoneCountryGuess(null, 'IN')).toBe('IN');
  });

  it('a pasted international number names its own country and drops the trunk zero', () => {
    expect(readTypedNumber('+91 098765 43210', 'US')).toEqual({
      country: 'IN',
      national: '9876543210',
    });
    expect(readTypedNumber('0044 7700 900123')).toEqual({ country: 'GB', national: '7700900123' });
  });

  it('a +1 number keeps Canada when Canada was chosen, and is the US otherwise', () => {
    expect(readTypedNumber('+1 416 555 0100', 'CA').country).toBe('CA');
    expect(readTypedNumber('+1 416 555 0100', null).country).toBe('US');
  });

  it('a national number is only digits', () => {
    expect(readTypedNumber('(415) 555-0100')).toEqual({ national: '4155550100' });
  });

  it('builds E.164 only when both halves are there', () => {
    expect(toE164('IN', '9876543210')).toBe('+919876543210');
    expect(toE164(null, '9876543210')).toBe('');
    expect(toE164('IN', '')).toBe('');
  });
});
