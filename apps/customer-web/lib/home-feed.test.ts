import { describe, expect, it } from 'vitest';
import { nearestFirst, outsideGroups, photosFirst, postersFirst } from './home-feed';

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

describe('outsideGroups', () => {
  const at = (id: string, country: string, currency: string, photo = true) => ({
    ...ev(id, country, photo),
    currency,
  });
  const list = [
    at('tor', 'CA', 'CAD'),
    at('nyc', 'US', 'USD'),
    at('del', 'IN', 'INR'),
    at('bom', 'India', 'INR', false),
    at('boi', 'US', 'USD', false),
  ];

  it('never puts two currencies in one group', () => {
    for (const g of outsideGroups(list, { currency: 'INR', country: 'IN' })) {
      expect(new Set(g.items.map((e) => e.currency))).toEqual(new Set([g.currency]));
    }
  });

  it("puts the visitor's own currency first", () => {
    expect(outsideGroups(list, { currency: 'INR', country: 'IN' }).map((g) => g.currency)).toEqual([
      'INR',
      'CAD',
      'USD',
    ]);
    expect(outsideGroups(list, { currency: 'USD', country: 'US' })[0]).toMatchObject({
      currency: 'USD',
      items: [{ id: 'nyc' }, { id: 'boi' }],
    });
  });

  it('caps the groups and the items in each', () => {
    const groups = outsideGroups(
      list,
      { currency: 'CAD', country: 'CA' },
      { perGroup: 1, maxGroups: 2 },
    );
    expect(groups.map((g) => [g.currency, g.items.length])).toEqual([
      ['CAD', 1],
      ['USD', 1],
    ]);
  });
});
