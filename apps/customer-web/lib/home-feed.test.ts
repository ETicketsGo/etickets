import { describe, expect, it } from 'vitest';
import {
  buyability,
  chooseHero,
  heroCandidates,
  nearestFirst,
  outsideGroups,
  photosFirst,
  postersFirst,
  priceSlot,
} from './home-feed';

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

describe('buyability', () => {
  const now = new Date('2026-11-01T00:00:00Z');
  const session = (
    startsAt: string,
    types: { available: number; saleState?: 'ON_SALE' | 'NOT_YET' | 'CLOSED' }[],
    status = 'SCHEDULED',
  ) => ({ startsAt, status, ticketTypes: types });

  it('is buyable with a ticket on sale and some left', () => {
    expect(
      buyability({ sessions: [session('2026-11-20T00:00:00Z', [{ available: 3 }])] }, now),
    ).toBe('BUYABLE');
  });

  it('is sold out when every on-sale ticket has none left', () => {
    expect(
      buyability(
        { sessions: [session('2026-11-20T00:00:00Z', [{ available: 0, saleState: 'ON_SALE' }])] },
        now,
      ),
    ).toBe('SOLD_OUT');
  });

  it('does not count a session that started, or one that is paused', () => {
    expect(
      buyability(
        {
          sessions: [
            session('2026-10-20T00:00:00Z', [{ available: 9 }]),
            session('2026-11-20T00:00:00Z', [{ available: 9 }], 'PAUSED'),
          ],
        },
        now,
      ),
    ).toBe('CLOSED');
  });

  it('knows sales that have not opened from sales that have closed', () => {
    const at = '2026-11-20T00:00:00Z';
    expect(
      buyability({ sessions: [session(at, [{ available: 5, saleState: 'NOT_YET' }])] }, now),
    ).toBe('NOT_YET');
    expect(
      buyability({ sessions: [session(at, [{ available: 5, saleState: 'CLOSED' }])] }, now),
    ).toBe('CLOSED');
  });
});

describe('chooseHero', () => {
  const card = (slug: string, photo: boolean) => ({ ...ev(slug, 'IN', photo), slug });
  const list = [card('soldout', true), card('nophoto', false), card('open', true)];

  it('skips a sold-out show and a listing without a photo', () => {
    const states = new Map([
      ['soldout', 'SOLD_OUT' as const],
      ['open', 'BUYABLE' as const],
    ]);
    expect(chooseHero(list, states)).toEqual({ hero: list[2], pending: false });
  });

  it('waits rather than guess while an earlier candidate is unknown', () => {
    expect(chooseHero(list, new Map([['open', 'BUYABLE' as const]]))).toEqual({
      hero: null,
      pending: true,
    });
  });

  it('has no hero when nothing with a photo can be bought', () => {
    const states = new Map([
      ['soldout', 'SOLD_OUT' as const],
      ['open', 'CLOSED' as const],
    ]);
    expect(chooseHero(list, states)).toEqual({ hero: null, pending: false });
    expect(heroCandidates(list)).toEqual(['soldout', 'open']);
  });
});

describe('priceSlot', () => {
  it('shows a price only for an event proven to be on sale', () => {
    expect(priceSlot('BUYABLE')).toBe('price');
    expect(priceSlot(undefined)).toBe('none');
  });

  it('names why an unbuyable card has no price', () => {
    expect(priceSlot('SOLD_OUT')).toBe('soldOut');
    expect(priceSlot('NOT_YET')).toBe('notYet');
    expect(priceSlot('CLOSED')).toBe('closed');
  });
});
