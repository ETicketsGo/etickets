import { describe, expect, it } from 'vitest';
import { countryAliases } from './country';
import {
  MARKETS,
  marketFor,
  marketSpellings,
  postalCodeProblem,
  unambiguousZoneFor,
  venueZone,
} from './markets';

describe('the zone a venue runs in', () => {
  it('is the only zone a single-zone country has, in any stored spelling', () => {
    expect(unambiguousZoneFor('IN')).toBe('Asia/Kolkata');
    expect(unambiguousZoneFor('India')).toBe('Asia/Kolkata');
    expect(unambiguousZoneFor('india')).toBe('Asia/Kolkata');
    expect(unambiguousZoneFor('UK')).toBe('Europe/London');
  });

  it('is never guessed for a country with several zones, or an unknown one', () => {
    expect(unambiguousZoneFor('US')).toBeNull();
    expect(unambiguousZoneFor('Canada')).toBeNull();
    expect(unambiguousZoneFor('AU')).toBeNull();
    expect(unambiguousZoneFor('Atlantis')).toBeNull();
    expect(unambiguousZoneFor(null)).toBeNull();
  });

  it('prefers the zone the venue was given over its country', () => {
    expect(venueZone('Asia/Dubai', 'IN')).toBe('Asia/Dubai');
    expect(venueZone(null, 'IN')).toBe('Asia/Kolkata');
    expect(venueZone('  ', 'IN')).toBe('Asia/Kolkata');
    expect(venueZone(null, 'US')).toBeNull();
  });
});

describe('every spelling of a market', () => {
  it('is a spelling marketFor reads as that market, and no other market claims it', () => {
    const seen = new Map<string, string>();
    for (const m of MARKETS) {
      for (const spelling of marketSpellings(m.code)) {
        expect([spelling, marketFor(spelling)?.code]).toEqual([spelling, m.code]);
        expect([spelling, seen.get(spelling) ?? m.code]).toEqual([spelling, m.code]);
        seen.set(spelling, m.code);
      }
    }
  });

  it('includes every spelling the currency table matches, so no admin filter finds fewer rows', () => {
    for (const m of MARKETS) {
      expect(marketSpellings(m.code)).toEqual(expect.arrayContaining(countryAliases(m.code)));
    }
  });

  it('reaches the spellings already in the database, and nothing fuzzy', () => {
    expect(marketSpellings('US')).toEqual(
      expect.arrayContaining(['us', 'usa', 'united states', 'united states of america', 'u.s.a.']),
    );
    expect(marketSpellings('us')).toEqual(marketSpellings('US'));
    expect(marketSpellings('GB')).toEqual(expect.arrayContaining(['gb', 'uk', 'united kingdom']));
    expect(marketSpellings('US')).not.toContain('america');
  });

  it('is just the code itself for a code that is not a market', () => {
    expect(marketSpellings('ZZ')).toEqual(['zz']);
    expect(marketSpellings('  ')).toEqual([]);
  });
});

describe('the postal code an address can carry', () => {
  it('takes a US ZIP or ZIP+4 and an Indian PIN, in any stored spelling of the country', () => {
    expect(postalCodeProblem('United States', '83642')).toBeNull();
    expect(postalCodeProblem('USA', '83642-1234')).toBeNull();
    expect(postalCodeProblem('IN', '520010')).toBeNull();
  });

  it("names the country's own term when the shape is wrong", () => {
    expect(postalCodeProblem('United States', '8364')).toMatch(/ZIP code/);
    expect(postalCodeProblem('India', '83642')).toMatch(/PIN code/);
    expect(postalCodeProblem('India', '020010')).toMatch(/PIN code/);
  });

  it('checks nothing for a blank code, an unknown country, or one with no fixed shape', () => {
    expect(postalCodeProblem('India', '')).toBeNull();
    expect(postalCodeProblem('', 'anything')).toBeNull();
    expect(postalCodeProblem('United Kingdom', 'SW1A 1AA')).toBeNull();
  });
});

describe('one zone name for one zone, on every surface (PROD, 2026-11-05)', () => {
  it('names the zone the way people say it, not as an offset, where a name exists', async () => {
    const { zoneAbbrev } = await import('./format');
    // A Meridian (Idaho) show in November: the console said MST, the storefront said GMT-7.
    expect(zoneAbbrev('2026-11-12T01:00:00Z', 'America/Boise')).toBe('MST');
    expect(zoneAbbrev('2026-07-12T01:00:00Z', 'America/Boise')).toBe('MDT');
    expect(zoneAbbrev('2026-11-12T01:00:00Z', 'Asia/Kolkata')).toBe('IST');
    expect(zoneAbbrev('2026-11-12T01:00:00Z', 'America/New_York')).toBe('EST');
  });
});
