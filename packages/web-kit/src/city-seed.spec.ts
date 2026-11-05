import { describe, expect, it } from 'vitest';
import {
  ALL_CITIES,
  citySeedFrom,
  cityScope,
  parseStoredCity,
  scopeInputFromSeed,
  serializeStoredCity,
} from './city-scope';

/**
 * Where the server starts a page: the cookies the browser mirrors from its city preference.
 *
 * The server renders the first paint in this place and the browser's provider starts from the
 * same value, so the two must read a cookie exactly as the browser reads localStorage. If they
 * disagree, the page is drawn in one place and redrawn in another - the flash this exists to end.
 */
describe('citySeedFrom', () => {
  it('knows nothing on a first visit, and says it is not ready to fetch', () => {
    expect(citySeedFrom({ stored: undefined, market: undefined })).toEqual({
      city: null,
      place: null,
      chosen: false,
      country: null,
      ready: false,
    });
  });

  it('a market resolved on an earlier visit is a ready country scope', () => {
    const seed = citySeedFrom({ stored: undefined, market: 'IN' });
    expect(seed).toMatchObject({ city: null, chosen: false, country: 'IN', ready: true });
    expect(cityScope(scopeInputFromSeed(seed))).toEqual({ country: 'IN' });
  });

  it('a chosen city carries its own country, which beats the network guess', () => {
    const stored = encodeURIComponent(
      serializeStoredCity('Hyderabad', { region: 'Telangana', country: 'IN' }),
    );
    const seed = citySeedFrom({ stored, market: 'US' });
    expect(seed).toMatchObject({ city: 'Hyderabad', chosen: true, country: 'IN', ready: true });
    expect(cityScope(scopeInputFromSeed(seed))).toEqual({
      city: 'Hyderabad',
      cityCountry: 'IN',
      region: 'Telangana',
    });
  });

  it('"All cities" is a choice that keeps the country scope and filters by no city', () => {
    const seed = citySeedFrom({ stored: ALL_CITIES, market: 'IN' });
    expect(seed).toMatchObject({ city: ALL_CITIES, chosen: true, country: 'IN', ready: true });
    expect(scopeInputFromSeed(seed)).toEqual({ city: null, place: null, country: 'IN' });
  });

  it('a country spelled out by a venue is read as its code', () => {
    const stored = serializeStoredCity('Boise', { region: 'Idaho', country: 'United States' });
    expect(citySeedFrom({ stored, market: undefined }).country).toBe('US');
  });

  it('a bare legacy city name with no market is not ready: its country is unknown', () => {
    expect(citySeedFrom({ stored: 'Mumbai', market: undefined })).toMatchObject({
      city: 'Mumbai',
      chosen: true,
      country: null,
      ready: false,
    });
  });

  it('ignores a cookie it cannot read rather than failing the page', () => {
    expect(citySeedFrom({ stored: '%E0%A4%A', market: 'zz-bad' })).toMatchObject({
      country: null,
      ready: false,
    });
    expect(parseStoredCity('{not json')).toBeNull();
  });
});

describe('serializeStoredCity / parseStoredCity', () => {
  it('round-trips a city with its place, and "All cities"', () => {
    const place = { region: 'Maharashtra', country: 'IN' };
    expect(parseStoredCity(serializeStoredCity('Mumbai', place))).toEqual({
      city: 'Mumbai',
      place,
    });
    expect(serializeStoredCity(ALL_CITIES)).toBe(ALL_CITIES);
  });
});
