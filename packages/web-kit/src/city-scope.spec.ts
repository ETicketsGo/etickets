import { describe, it, expect } from 'vitest';
import { cityScope, type CityPreference } from './city';

/**
 * What the storefront asks the API for, given where we think the customer is.
 *
 * This is one function because it was previously three answers: the home page ignored the
 * preference entirely, Browse used the city, and Movies used the city too but disagreed
 * about the empty case. The chip in the header said Bengaluru and the homepage under it
 * showed Mumbai — which reads as the filter being broken, and was.
 *
 * The tests below are about the RANKING, which is the part that is easy to get wrong: a
 * city is a choice, a country is a guess, and a guess must never override a choice or
 * survive being told "everywhere".
 */
const preference = (over: Partial<CityPreference> = {}): CityPreference => ({
  city: null,
  country: null,
  topCities: [],
  suggestion: null,
  chosen: false,
  setCity: () => undefined,
  clearCity: () => undefined,
  dismissSuggestion: () => undefined,
  useMyLocation: async () => undefined,
  locating: false,
  searchCities: async () => [],
  ...over,
});

describe('cityScope', () => {
  it('asks for the chosen city', () => {
    expect(cityScope(preference({ city: 'Mumbai' }))).toEqual({ city: 'Mumbai' });
  });

  it('falls back to the country when no city is chosen', () => {
    // The user-visible point of the whole change: a visitor in India should not have to
    // read past a comedy night in Idaho to find what is on near them.
    expect(cityScope(preference({ country: 'IN' }))).toEqual({ country: 'IN' });
  });

  it('never sends both, so a wrong country cannot empty a city the customer chose', () => {
    /*
      The failure this prevents: the locale says US, the customer picks Mumbai, and the
      request asks for a Mumbai in the United States. Nothing matches, and the page they
      deliberately narrowed goes blank with no explanation.
    */
    expect(cityScope(preference({ city: 'Mumbai', country: 'US' }))).toEqual({ city: 'Mumbai' });
  });

  it('treats "all cities" as all cities IN THAT COUNTRY, not worldwide', () => {
    /*
      The decision this encodes, made after a visitor in the United States opened the
      storefront with "All cities" selected and was led with a comedy night in Hyderabad and
      a gig in Mumbai.

      Clearing a city filter is how somebody stops narrowing to ONE city. It is not how they
      ask to be shown another continent, in a currency their card would be charged in, for a
      venue they cannot reach. So no city plus a known country is that country -- the header
      names it, so the control is not quietly narrower than it claims.

      The hook is what regressed here: it dropped the country whenever the city was cleared,
      including on every page load for somebody whose stored choice was "all cities".
    */
    expect(cityScope(preference({ city: null, country: 'US' }))).toEqual({ country: 'US' });
  });

  it('asks for everything when we know nothing', () => {
    // No hint must mean no filter — never a filter on an empty string, which would match
    // only venues with a blank country and show a dead platform.
    expect(cityScope(preference())).toEqual({});
  });
});
