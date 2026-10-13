import { describe, expect, it } from 'vitest';
import { groupCitiesByCountry, placeGroupRequests } from './place-groups';

describe('placeGroupRequests', () => {
  it('asks for the rest of the selected city country, then each other country, nearest first', () => {
    expect(placeGroupRequests({ city: 'Mumbai', country: 'India' })).toEqual([
      {
        kind: 'sameCountry',
        code: 'IN',
        name: 'India',
        params: { country: 'IN', excludeCity: 'Mumbai' },
      },
      { kind: 'elsewhere', code: 'US', name: 'United States', params: { country: 'US' } },
      { kind: 'elsewhere', code: 'CA', name: 'Canada', params: { country: 'CA' } },
    ]);
  });

  it('puts the home country out of "elsewhere" whatever spelling it arrives in', () => {
    for (const country of ['US', 'USA', 'United States']) {
      const codes = placeGroupRequests({ city: 'Boise', country }).map((r) => r.code);
      expect(codes).toEqual(['US', 'IN', 'CA']);
    }
  });

  it('with a country and no city there is no "same country" group: the page is the country', () => {
    const reqs = placeGroupRequests({ country: 'CA' });
    expect(reqs.map((r) => [r.kind, r.code])).toEqual([
      ['elsewhere', 'IN'],
      ['elsewhere', 'US'],
    ]);
  });

  it('a visitor from a country we do not cover still gets all three markets as "elsewhere"', () => {
    const reqs = placeGroupRequests({ country: 'GB' });
    expect(reqs.map((r) => r.code)).toEqual(['IN', 'US', 'CA']);
    expect(reqs.every((r) => r.kind === 'elsewhere')).toBe(true);
  });

  it('with a city but no known country it asks for nothing rather than guess a group', () => {
    expect(placeGroupRequests({ city: 'Pune' })).toEqual([]);
  });

  it('asks for nothing when there is no place to be far from', () => {
    expect(placeGroupRequests({})).toEqual([]);
    expect(placeGroupRequests({ city: null, country: null })).toEqual([]);
  });
});

describe('groupCitiesByCountry', () => {
  const c = (city: string, country: string, eventCount: number, countryCode?: string) => ({
    city,
    country,
    countryCode,
    eventCount,
  });

  it('lists a city once even when an older API sends "India" and "IN" rows', () => {
    const groups = groupCitiesByCountry([
      c('Hyderabad', 'India', 2),
      c('Hyderabad', 'IN', 3),
      c('Bengaluru', 'IN', 1),
      c('bengaluru', 'India', 1),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ code: 'IN', name: 'India' });
    expect(groups[0].cities.map((x) => [x.city, x.eventCount])).toEqual([
      ['Hyderabad', 5],
      ['Bengaluru', 2],
    ]);
  });

  it("leads with the visitor's country, then the busiest", () => {
    const list = [
      c('Mumbai', 'India', 9, 'IN'),
      c('Boise', 'United States', 2, 'US'),
      c('Toronto', 'Canada', 4, 'CA'),
    ];
    expect(groupCitiesByCountry(list).map((g) => g.code)).toEqual(['IN', 'CA', 'US']);
    expect(groupCitiesByCountry(list, 'US').map((g) => g.code)).toEqual(['US', 'IN', 'CA']);
    expect(groupCitiesByCountry(list, 'Canada').map((g) => g.code)).toEqual(['CA', 'IN', 'US']);
  });
});
