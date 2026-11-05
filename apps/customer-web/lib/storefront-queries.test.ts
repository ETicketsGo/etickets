import { describe, expect, it } from 'vitest';
import { hashKey } from '@tanstack/react-query';
import {
  browseEventsQuery,
  browseRequest,
  discoveryQuery,
  emptyPlaceCountry,
  homeEventsQuery,
  homeMoviesQuery,
  initialBrowseFilters,
  initialMovieFilters,
  moviesListQuery,
} from './storefront-queries';
import { homeDetailSlugs } from './home-feed';

/**
 * The server renders a storefront page with these reads and the browser finds them in its cache
 * only if it builds the SAME key. A key that differs by one field is a miss: a skeleton, a second
 * request and the page jumping when it lands. These pin the keys to what the pages asked for
 * before the server started answering for them, so a refactor cannot silently split the two.
 */
const params = (q: Record<string, string>) => ({ get: (k: string) => q[k] ?? null });
const india = { city: null, place: null, country: 'IN' };
const hyderabad = {
  city: 'Hyderabad',
  place: { region: 'Telangana', country: 'IN' },
  country: 'IN',
};

describe('storefront query keys', () => {
  it('home: the scope is part of the key, spelled as the page always spelled it', () => {
    expect(homeEventsQuery(india).queryKey).toEqual(['events', 'home', '{"country":"IN"}']);
    expect(homeEventsQuery(hyderabad).queryKey).toEqual([
      'events',
      'home',
      '{"city":"Hyderabad","cityCountry":"IN","region":"Telangana"}',
    ]);
    expect(homeMoviesQuery(india).queryKey).toEqual(['movies', 'home', '{"country":"IN"}']);
  });

  it('Browse: a filter left unset hashes like one never mentioned', () => {
    const start = initialBrowseFilters(params({}), india);
    expect(start).toEqual({ q: undefined, city: undefined, category: undefined });
    const fromServer = browseEventsQuery(browseRequest(start, india), 1).queryKey;
    // What the page held before this change: `{}` then `{ city: undefined }` from its effect.
    const fromEffect = browseEventsQuery(browseRequest({ city: undefined }, india), 1).queryKey;
    expect(hashKey(fromServer)).toBe(hashKey(fromEffect));
    expect(browseRequest(start, india)).toMatchObject({ country: 'IN' });
  });

  it("Browse: a ?city= link wins over the header, and carries no other city's place", () => {
    const start = initialBrowseFilters(params({ city: 'Pune' }), hyderabad);
    expect(start.city).toBe('Pune');
    expect(browseRequest(start, hyderabad)).toEqual({
      q: undefined,
      city: 'Pune',
      category: undefined,
    });
  });

  it("Browse: the header's chosen city starts the page, with its own state and country", () => {
    const start = initialBrowseFilters(params({ q: 'jazz' }), hyderabad);
    expect(start).toEqual({ q: 'jazz', city: 'Hyderabad', category: undefined });
    expect(browseRequest(start, hyderabad)).toMatchObject({
      city: 'Hyderabad',
      cityCountry: 'IN',
      region: 'Telangana',
    });
    expect(browseRequest({ freeOnly: true }, india)).toEqual({ freeOnly: 'true', country: 'IN' });
  });

  it('Movies and Explore: deep links and the place are in the key', () => {
    const start = initialMovieFilters(params({ genre: 'Drama' }));
    expect(moviesListQuery(start, india).queryKey).toEqual([
      'movies',
      { q: undefined, genre: 'Drama' },
      '{"country":"IN"}',
    ]);
    expect(hashKey(moviesListQuery(initialMovieFilters(params({})), india).queryKey)).toBe(
      hashKey(['movies', {}, '{"country":"IN"}']),
    );
    expect(discoveryQuery(india).queryKey).toEqual(['discovery', '{"country":"IN"}']);
  });

  it("the empty state offers cities in the chosen city's country, else the scope", () => {
    expect(emptyPlaceCountry(hyderabad)).toBe('IN');
    expect(emptyPlaceCountry({ city: null, place: null, country: 'US' })).toBe('US');
    expect(emptyPlaceCountry({ city: null, place: null, country: null })).toBeNull();
  });
});

describe('homeDetailSlugs', () => {
  const ev = (slug: string, photo: boolean) => ({
    slug,
    imagePath: photo ? `/img/${slug}` : null,
    venue: { country: 'IN' },
  });

  it('reads the hero candidates (photos first) and the first nine, each once', () => {
    const list = [ev('a', false), ev('b', true), ev('c', true)];
    expect(homeDetailSlugs(list)).toEqual(['b', 'c', 'a']);
  });

  it('is bounded: six hero candidates and nine listed, never the whole feed', () => {
    const list = Array.from({ length: 30 }, (_, i) => ev(`e${i}`, i % 2 === 0));
    const slugs = homeDetailSlugs(list);
    expect(slugs.length).toBeLessThanOrEqual(15);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
