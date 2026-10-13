import { describe, expect, it } from 'vitest';
import { money } from '@eticketsgo/shared-types';
import { nearestFirst, needsCurrencyCode, photosFirst, postersFirst } from './home-feed';

const ev = (id: string, country: string, photo: boolean) => ({
  id,
  venue: { country },
  imagePath: photo ? `/img/${id}` : null,
});

describe('photosFirst', () => {
  it('puts listings with a photo ahead and otherwise keeps the API order', () => {
    const list = [
      ev('a', 'IN', false),
      ev('b', 'IN', true),
      ev('c', 'IN', false),
      ev('d', 'IN', true),
    ];
    expect(photosFirst(list).map((e) => e.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('does not change the list it was given', () => {
    const list = [ev('a', 'IN', false), ev('b', 'IN', true)];
    photosFirst(list);
    expect(list.map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('postersFirst', () => {
  it('puts films with a poster ahead', () => {
    const films = [
      { id: 'x', posterUrl: null },
      { id: 'y', posterUrl: '/p.jpg' },
    ];
    expect(postersFirst(films).map((f) => f.id)).toEqual(['y', 'x']);
  });
});

describe('nearestFirst', () => {
  it("puts the visitor's own country first, matching spelled-out venue countries", () => {
    const list = [
      ev('blr', 'India', true),
      ev('nyc', 'US', true),
      ev('tor', 'CA', true),
      ev('boi', 'United States', false),
    ];
    expect(nearestFirst(list, 'US').map((e) => e.id)).toEqual(['nyc', 'boi', 'blr', 'tor']);
  });

  it('with no known country it is photos first and nothing else', () => {
    const list = [ev('a', 'IN', false), ev('b', 'US', true)];
    expect(nearestFirst(list, null).map((e) => e.id)).toEqual(['b', 'a']);
  });
});

describe('needsCurrencyCode', () => {
  it('asks for the code where the symbol alone is ambiguous', () => {
    expect(needsCurrencyCode(money(4500, 'USD'))).toBe(true);
    expect(needsCurrencyCode(money(69900, 'INR'))).toBe(true);
  });

  it('does not repeat a currency the amount already names', () => {
    expect(needsCurrencyCode(money(3200, 'CAD'))).toBe(false);
    expect(needsCurrencyCode(money(4500, 'USD', 'fr-CA'))).toBe(false);
  });
});
