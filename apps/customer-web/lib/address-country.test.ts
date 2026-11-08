import { describe, expect, it } from 'vitest';
import { countryForAddress } from './address-country';

/** The real table (IP2Location LITE via ip3country), not a stand-in. */
describe('countryForAddress', () => {
  it('names the country of public IPv4 addresses in the launch markets', () => {
    expect(countryForAddress('8.8.8.8')).toBe('US');
    expect(countryForAddress('49.36.8.9')).toBe('IN'); // Reliance Jio
    expect(countryForAddress('::ffff:8.8.8.8')).toBe('US'); // IPv4-mapped form
  });

  it('is null for private, reserved, IPv6 and junk input - the browser decides then', () => {
    for (const v of [
      '10.1.2.3',
      '192.168.1.1',
      '127.0.0.1',
      '2401:4900::1',
      'nope',
      '',
      null,
      undefined,
      '1.2.3.4, 5.6.7.8',
    ]) {
      expect(countryForAddress(v)).toBeNull();
    }
  });
});
