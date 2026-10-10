import { describe, expect, it } from 'vitest';
import { countryAliases } from './country';
import { MARKETS, marketFor, marketSpellings, unambiguousZoneFor, venueZone } from './markets';

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
