import { describe, expect, it } from 'vitest';
import {
  MARKETS,
  DEFAULT_MARKET,
  marketFor,
  marketFromHint,
  regionFor,
  currencyForCountry,
  INDIA_STATES,
} from '@eticketsgo/shared-types';
import { locationFrom } from './location-fields';

/**
 * The country list, and the tolerance it needs to be useful.
 *
 * ── WHY THIS IS WORTH TESTING ──────────────────────────────────────────────────────
 * Country was a free-text box, so the database holds "India", "india", "IN" and whatever
 * anybody typed. A dropdown that only recognises its own canonical spelling would treat every
 * one of those historic rows as an unknown country — the venue would open on India regardless
 * of where it is, and saving it would quietly move it.
 *
 * The failure is silent in both directions, which is exactly the class of bug the free-text
 * field produced in the first place.
 */
describe('the market list', () => {
  it('agrees with the currency map it replaces', () => {
    // Two lists of the same eight countries already existed. If they disagree, an organizer
    // prices in one currency and is paid in another.
    for (const m of MARKETS) {
      expect(currencyForCountry(m.name), `${m.name} currency`).toBe(m.currency);
      expect(currencyForCountry(m.code), `${m.code} currency`).toBe(m.currency);
    }
  });

  it('opens on India, the launch market', () => {
    expect(DEFAULT_MARKET.code).toBe('IN');
  });

  it('gives every market at least one timezone, and names it first', () => {
    for (const m of MARKETS) {
      expect(m.timezones.length, `${m.name} has no timezone`).toBeGreaterThan(0);
      // Constructing the formatter is the only real check that a zone name is valid; a typo
      // here would be stored on a venue and every show time would be quoted in the wrong hour.
      for (const tz of m.timezones) {
        expect(() => new Intl.DateTimeFormat('en', { timeZone: tz }), tz).not.toThrow();
      }
    }
  });

  it('carries India’s states from the GST list rather than a second copy', () => {
    const india = marketFor('India')!;
    expect(india.regions).toHaveLength(INDIA_STATES.length);
    expect(india.regions.map((r) => r.name)).toContain('Telangana');
    expect(india.regionLabel).toBe('State');
  });

  it('calls each country’s subdivisions what that country calls them', () => {
    // A Canadian asked for their "state" is being asked by a form built for somewhere else.
    expect(marketFor('CA')!.regionLabel).toBe('Province or territory');
    expect(marketFor('AE')!.regionLabel).toBe('Emirate');
    expect(marketFor('AU')!.regionLabel).toBe('State or territory');
  });

  it('asks nothing where a country has no subdivision in an address', () => {
    expect(marketFor('Singapore')!.regions).toHaveLength(0);
  });
});

describe('matching a country somebody already typed', () => {
  it.each([
    ['India', 'IN'],
    ['india', 'IN'],
    ['IN', 'IN'],
    ['USA', 'US'],
    ['United States of America', 'US'],
    ['united states', 'US'],
    ['UK', 'GB'],
    ['uae', 'AE'],
  ])('%s → %s', (stored, code) => {
    expect(marketFor(stored)?.code).toBe(code);
  });

  it('returns null for a country we do not sell in, rather than guessing', () => {
    // Null is a safe answer. Quietly resolving "France" to India would move a venue.
    expect(marketFor('France')).toBeNull();
    expect(marketFor('')).toBeNull();
    expect(marketFor(null)).toBeNull();
  });
});

describe('matching a stored region', () => {
  it('accepts the full name and the abbreviation', () => {
    expect(regionFor('India', 'Telangana')?.name).toBe('Telangana');
    expect(regionFor('India', 'TG')?.name).toBe('Telangana');
    expect(regionFor('United States', 'ca')?.name).toBe('California');
  });

  it('does not match a region against the wrong country', () => {
    // "CA" is California in the US and Chandigarh's code in India. Answering across countries
    // would put a venue's place of supply in the wrong jurisdiction.
    expect(regionFor('Canada', 'California')).toBeNull();
  });
});

describe('the default a form opens on', () => {
  it('is a hint and falls back to the launch market', () => {
    expect(marketFromHint('US').code).toBe('US');
    expect(marketFromHint('FR').code).toBe('IN');
    expect(marketFromHint(null).code).toBe('IN');
  });
});

describe('loading an existing venue into the form', () => {
  it('normalises a stored spelling to the one the dropdown offers', () => {
    const v = locationFrom({ country: 'india', region: 'Telangana', timezone: 'Asia/Kolkata' });
    expect(v).toEqual({ country: 'India', region: 'Telangana', timezone: 'Asia/Kolkata' });
  });

  it('keeps a country we do not sell in instead of silently replacing it', () => {
    // Somebody's data. A dropdown that cannot represent it is not a reason to rewrite it.
    expect(locationFrom({ country: 'France' }).country).toBe('France');
  });

  it('falls back to the country’s primary zone when a venue has none', () => {
    expect(locationFrom({ country: 'United States', timezone: null }).timezone).toBe(
      'America/New_York',
    );
  });

  it('treats a missing region as unanswered rather than as a value', () => {
    expect(locationFrom({ country: 'India', region: null }).region).toBe('');
  });
});

/**
 * A dropdown nobody can scan is a dropdown people get wrong.
 *
 * `INDIA_STATES` is ordered by GST state code — correct for the reference file, and the
 * reason the venue form opened on Jammu and Kashmir with Assam above West Bengal. The order
 * a form shows is a presentation decision, and this is where it is made.
 */
describe('every market lists its regions alphabetically', () => {
  it.each(MARKETS.filter((m) => m.regions.length > 0).map((m) => [m.name, m] as const))(
    '%s',
    (_name, market) => {
      const shown = market.regions.map((r) => r.name);
      expect(shown).toEqual([...shown].sort((a, b) => a.localeCompare(b)));
    },
  );

  it('keeps the GST reference file in its own order', () => {
    // Sorting there would change what the file is: an official list, published in code order.
    expect(INDIA_STATES[0].code).toBe('01');
    expect(INDIA_STATES.map((s) => s.code)).toEqual(
      [...INDIA_STATES].sort((a, b) => a.code.localeCompare(b.code)).map((s) => s.code),
    );
  });
});
