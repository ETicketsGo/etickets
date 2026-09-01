import { countryAliases, countryMatches, currencyForCountry } from './country';

// Imported through the API's re-export rather than from shared-types directly: that is the
// path every module here uses, so it is the path worth proving.

/**
 * The whole point of this helper is that the two sides of a comparison never agree on
 * spelling, so the tests are written as pairs that must match despite looking different.
 */
describe('country matching', () => {
  it('matches an alpha-2 hint against the display name a venue stored', () => {
    // The real pairing: `cf-ipcountry: IN` meeting a venue whose country reads "India".
    expect(countryMatches('India', 'IN')).toBe(true);
    expect(countryMatches('india', 'in')).toBe(true);
    expect(countryMatches('  India  ', 'IN')).toBe(true);
  });

  it('matches in the other direction too, because callers hold either shape', () => {
    // A stored alpha-2 against a display-name filter — the same bug, mirrored.
    expect(countryMatches('IN', 'India')).toBe(true);
    expect(countryMatches('US', 'United States')).toBe(true);
  });

  it('treats the several spellings of one country as the same country', () => {
    for (const stored of ['USA', 'United States', 'United States of America', 'us']) {
      expect(countryMatches(stored, 'US')).toBe(true);
    }
  });

  it('does not match a different country', () => {
    expect(countryMatches('India', 'US')).toBe(false);
    expect(countryMatches('Canada', 'IN')).toBe(false);
  });

  it('falls back to comparing an unknown country with itself', () => {
    // A market nobody has added aliases for still filters correctly on its own spelling —
    // the list is an optimisation, not a gate.
    expect(countryMatches('Kenya', 'Kenya')).toBe(true);
    expect(countryMatches('kenya', 'KENYA')).toBe(true);
    expect(countryMatches('Kenya', 'Uganda')).toBe(false);
  });

  it('returns nothing for an empty country rather than a clause matching everything', () => {
    // Guards the query builder: `in: []` finds nothing, whereas `in: ['']` would be a
    // filter that quietly matches any venue whose country was left blank.
    expect(countryAliases('   ')).toEqual([]);
  });

  it('includes the caller spelling in the alias list, so an exact match never depends on the table', () => {
    expect(countryAliases('IN')).toContain('in');
    expect(countryAliases('India')).toContain('india');
  });
});

describe('currencyForCountry', () => {
  /*
    This decides real money — the fee tiers, the tax rules and which payment provider takes
    the charge — so the tests are written against the spellings that actually reach it from
    the venue form, not against tidy alpha-2 codes.
  */
  it('answers for a country however the venue spelled it', () => {
    for (const stored of ['US', 'USA', 'United States', 'united states of america']) {
      expect(currencyForCountry(stored)).toBe('USD');
    }
    for (const stored of ['IN', 'India', 'india']) {
      expect(currencyForCountry(stored)).toBe('INR');
    }
  });

  it('covers the markets the platform has fee bands for', () => {
    expect(currencyForCountry('Canada')).toBe('CAD');
    expect(currencyForCountry('GB')).toBe('GBP');
    expect(currencyForCountry('Singapore')).toBe('SGD');
  });

  it('returns null for a country it does not know, rather than guessing one', () => {
    /*
      The caller falls back to its own explicit default. Guessing a currency for an
      unconfigured market is how an organizer ends up selling in a denomination they never
      chose — which is the exact defect this replaced.
    */
    expect(currencyForCountry('Kenya')).toBeNull();
    expect(currencyForCountry('')).toBeNull();
    expect(currencyForCountry(null)).toBeNull();
    expect(currencyForCountry(undefined)).toBeNull();
  });
});
