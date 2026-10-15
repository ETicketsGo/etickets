import { describe, expect, it } from 'vitest';
import { MARKETS, marketFor } from './markets';
import {
  REGION_TIMEZONES,
  regionZone,
  sameClock,
  zoneForPlace,
  zoneInWords,
} from './region-timezones';

describe('the zone each state and province keeps', () => {
  it('maps every United States state and DC, every Canadian province and territory, and every Australian state', () => {
    for (const code of ['US', 'CA', 'AU']) {
      const market = marketFor(code)!;
      const unmapped = market.regions.map((r) => r.name).filter((n) => !REGION_TIMEZONES[code][n]);
      expect([code, unmapped]).toEqual([code, []]);
    }
    expect(Object.keys(REGION_TIMEZONES.US)).toHaveLength(51);
    expect(Object.keys(REGION_TIMEZONES.CA)).toHaveLength(13);
  });

  it('names only regions that exist, so a typo in the table cannot hide', () => {
    for (const [code, table] of Object.entries(REGION_TIMEZONES)) {
      const names = marketFor(code)!.regions.map((r) => r.name);
      for (const region of Object.keys(table))
        expect([code, names.includes(region)]).toEqual([code, true]);
    }
  });

  it('only answers with zones the country offers, so the picker can always show the answer', () => {
    for (const [code, table] of Object.entries(REGION_TIMEZONES)) {
      const offered = MARKETS.find((m) => m.code === code)!.timezones;
      for (const [region, zone] of Object.entries(table)) {
        expect([region, offered.includes(zone)]).toEqual([region, true]);
        // A zone name only a formatter can validate: a typo here would mis-time every show.
        expect(() => new Intl.DateTimeFormat('en', { timeZone: zone })).not.toThrow();
      }
    }
  });

  it('gives the documented zone for the cases people get wrong', () => {
    expect(regionZone('United States', 'Idaho')).toBe('America/Boise');
    expect(regionZone('United States', 'Arizona')).toBe('America/Phoenix');
    expect(regionZone('United States', 'Texas')).toBe('America/Chicago');
    expect(regionZone('United States', 'Florida')).toBe('America/New_York');
    expect(regionZone('United States', 'Indiana')).toBe('America/New_York');
    expect(regionZone('United States', 'Tennessee')).toBe('America/Chicago');
    expect(regionZone('United States', 'Hawaii')).toBe('Pacific/Honolulu');
    expect(regionZone('Canada', 'Ontario')).toBe('America/Toronto');
    expect(regionZone('Canada', 'Saskatchewan')).toBe('America/Regina');
    expect(regionZone('Canada', 'Yukon')).toBe('America/Whitehorse');
    expect(regionZone('Canada', 'Newfoundland and Labrador')).toBe('America/St_Johns');
  });

  it('reads stored spellings of the country and the region', () => {
    expect(regionZone('US', 'ID')).toBe('America/Boise');
    expect(regionZone('usa', 'idaho')).toBe('America/Boise');
    expect(regionZone('CA', 'qc')).toBe('America/Toronto');
  });

  it('has no answer for no region, an unknown one, or a single-zone country', () => {
    expect(regionZone('United States', '')).toBeNull();
    expect(regionZone('United States', null)).toBeNull();
    expect(regionZone('United States', 'Atlantis')).toBeNull();
    expect(regionZone('India', 'Telangana')).toBeNull();
  });
});

describe('the zone a place keeps when nobody chose one', () => {
  it('is the region zone, else the country only zone, else unknown', () => {
    expect(zoneForPlace('United States', 'Idaho')).toBe('America/Boise');
    expect(zoneForPlace('India', 'Telangana')).toBe('Asia/Kolkata');
    expect(zoneForPlace('India', '')).toBe('Asia/Kolkata');
    expect(zoneForPlace('United States', '')).toBeNull();
    expect(zoneForPlace(null, null)).toBeNull();
  });
});

describe('a zone in plain words', () => {
  it('names the clock and the city, and says when there is no daylight saving', () => {
    expect(zoneInWords('America/Boise')).toBe('Mountain time (Boise)');
    expect(zoneInWords('America/New_York')).toBe('Eastern time (New York)');
    expect(zoneInWords('America/Phoenix')).toBe('Mountain time (Phoenix), no daylight saving');
    expect(zoneInWords('Asia/Kolkata')).toBe('India time (Kolkata)');
  });

  it('has words for every zone a market offers', () => {
    for (const m of MARKETS) {
      for (const zone of m.timezones)
        expect([zone, zoneInWords(zone).includes('(')]).toEqual([zone, true]);
    }
  });

  it('falls back to the readable key for a zone it does not know', () => {
    expect(zoneInWords('Europe/Isle_of_Man')).toBe('Europe/Isle of Man');
  });
});

describe('two zones keeping the same clock', () => {
  const at = new Date('2026-10-15T00:00:00Z');
  it('is true for different names of one clock', () => {
    expect(sameClock('America/Denver', 'America/Boise', at)).toBe(true);
    expect(sameClock('America/New_York', 'America/Indiana/Indianapolis', at)).toBe(true);
    expect(sameClock('Asia/Kolkata', 'Asia/Kolkata', at)).toBe(true);
  });

  it('is false where any show time would read differently, even for part of the year', () => {
    expect(sameClock('America/New_York', 'America/Boise', at)).toBe(false);
    expect(sameClock('America/Denver', 'America/Phoenix', at)).toBe(false);
    expect(sameClock('America/Vancouver', 'America/Whitehorse', at)).toBe(false);
    expect(sameClock('America/Denver', 'Not/AZone', at)).toBe(false);
  });
});
