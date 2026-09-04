import { describe, it, expect } from 'vitest';
import { inCityScope, cityScope, type CityPreference } from './city';

/**
 * The one list the server does not filter.
 *
 * ── WHAT WAS REPORTED ──────────────────────────────────────────────────────────────
 * Meridian chosen in the header, and the home page still showing a Hyderabad comedy show
 * and a Mumbai gig. Checked against the running site: Browse, Movies, "This weekend" and
 * "Happening in Meridian" were all correctly scoped and returned Meridian events only. The
 * leak was "Continue exploring", which is read from this browser's own history and so had
 * nothing filtering it at all.
 *
 * That made the bug look bigger than it was and easier to misdiagnose: because every other
 * section was correctly narrowed to two Meridian events, the out-of-scope ones were most of
 * what was visible — so the scoping appeared broken at exactly the moment it was working.
 *
 * ── WHY THIS MIRRORS `cityScope` ───────────────────────────────────────────────────
 * `cityScope` decides what the SERVER is asked for. This decides the same thing for a list
 * held locally. They have to agree, and the tests below check that they do rather than
 * trusting two similar-looking functions to stay similar.
 */
const preference = (over: Partial<CityPreference> = {}): CityPreference =>
  ({
    city: null,
    country: null,
    topCities: [],
    detect: async () => {},
    setCity: () => {},
    clearCity: () => {},
    locating: false,
    searchCities: async () => [],
    ...over,
  }) as CityPreference;

const event = (city: string | null, country: string | null = 'India') => ({
  venue: { city, country },
});

describe('a chosen city is the whole scope', () => {
  it('keeps events in that city', () => {
    expect(inCityScope(event('Meridian', 'USA'), preference({ city: 'Meridian' }))).toBe(true);
  });

  it('drops events anywhere else, including the same country', () => {
    const p = preference({ city: 'Meridian' });
    expect(inCityScope(event('Hyderabad'), p)).toBe(false);
    expect(inCityScope(event('Mumbai'), p)).toBe(false);
    // Same country, different city: still out of scope. A city choice is not a hint.
    expect(inCityScope(event('Boise', 'USA'), p)).toBe(false);
  });

  it('matches however the city was cased or padded', () => {
    // The header's value comes from a picker, an IP lookup or a stored string, and those
    // three do not agree about capitalisation.
    for (const c of ['meridian', 'MERIDIAN', '  Meridian ']) {
      expect(inCityScope(event(c, 'USA'), preference({ city: 'Meridian' }))).toBe(true);
    }
  });
});

describe('with no city, the country is the scope', () => {
  it('keeps events in that country and drops the rest', () => {
    const p = preference({ country: 'USA' });
    expect(inCityScope(event('Meridian', 'USA'), p)).toBe(true);
    expect(inCityScope(event('Hyderabad', 'India'), p)).toBe(false);
  });
});

describe('what it refuses to hide', () => {
  it('shows everything when nothing has been chosen', () => {
    // The first visit. Filtering here would empty the strip for a reason the customer has
    // not given.
    expect(inCityScope(event('Hyderabad'), preference())).toBe(true);
    expect(inCityScope(event('Meridian', 'USA'), preference())).toBe(true);
  });

  it('keeps an event whose venue is unknown', () => {
    /*
      An event we cannot place is not evidence that it is somewhere else. Hiding it would
      silently drop online or venue-less events from a strip the customer expects to hold
      what they just looked at.
    */
    expect(inCityScope({ venue: null }, preference({ city: 'Meridian' }))).toBe(true);
    expect(inCityScope({}, preference({ city: 'Meridian' }))).toBe(true);
    expect(inCityScope(event(null, null), preference({ city: 'Meridian' }))).toBe(false);
  });
});

describe('it asks the same question the server is asked', () => {
  /*
    The failure this guards against is subtle: two functions that look alike, drift, and
    leave one page filtering its server list by city and its local list by country. Rather
    than assert the implementations match, these check the OUTCOMES agree.
  */
  const cases: { p: CityPreference; city: string; country: string; expected: boolean }[] = [
    { p: preference({ city: 'Meridian' }), city: 'Meridian', country: 'USA', expected: true },
    { p: preference({ city: 'Meridian' }), city: 'Mumbai', country: 'India', expected: false },
    { p: preference({ country: 'India' }), city: 'Mumbai', country: 'India', expected: true },
    { p: preference({ country: 'India' }), city: 'Meridian', country: 'USA', expected: false },
    { p: preference(), city: 'Anywhere', country: 'Anywhere', expected: true },
  ];

  it('agrees with cityScope on every combination', () => {
    for (const c of cases) {
      const asked = cityScope(c.p);
      const serverWouldReturn = asked.city
        ? asked.city.toLowerCase() === c.city.toLowerCase()
        : asked.country
          ? asked.country.toLowerCase() === c.country.toLowerCase()
          : true;
      expect(serverWouldReturn).toBe(c.expected);
      expect(inCityScope(event(c.city, c.country), c.p)).toBe(c.expected);
    }
  });
});
