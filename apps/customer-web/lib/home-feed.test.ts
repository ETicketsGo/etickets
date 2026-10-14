import { describe, expect, it } from 'vitest';
import {
  buyability,
  chooseHero,
  emptyStage,
  heroCandidates,
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

describe('sample content ordering', () => {
  const labelled = (id: string, contentLabel: 'DEMO' | 'TEST' | null, photo: boolean) => ({
    ...ev(id, 'IN', photo),
    contentLabel,
  });

  it('puts DEMO before TEST, then photos, and never drops a TEST listing', () => {
    const list = [
      labelled('t-photo', 'TEST', true),
      labelled('d-plain', 'DEMO', false),
      labelled('t-plain', 'TEST', false),
      labelled('d-photo', 'DEMO', true),
    ];
    expect(photosFirst(list).map((e) => e.id)).toEqual([
      'd-photo',
      'd-plain',
      't-photo',
      't-plain',
    ]);
  });

  it('prefers a DEMO event for the hero when it has a photo and can be bought', () => {
    const list = [labelled('test', 'TEST', true), labelled('demo', 'DEMO', true)];
    const states = new Map<string, 'BUYABLE'>([
      ['test', 'BUYABLE'],
      ['demo', 'BUYABLE'],
    ]);
    const slugged = list.map((e) => ({ ...e, slug: e.id }));
    expect(chooseHero(slugged, states).hero?.id).toBe('demo');
  });

  it('falls back to a TEST event when no DEMO event is buyable', () => {
    const slugged = [labelled('test', 'TEST', true), labelled('demo', 'DEMO', true)].map((e) => ({
      ...e,
      slug: e.id,
    }));
    const states = new Map<string, 'BUYABLE' | 'SOLD_OUT'>([
      ['test', 'BUYABLE'],
      ['demo', 'SOLD_OUT'],
    ]);
    expect(chooseHero(slugged, states).hero?.id).toBe('test');
  });

  it('leaves the order alone when nothing is labelled (production)', () => {
    const list = [
      labelled('a', null, false),
      labelled('b', null, true),
      labelled('c', null, false),
    ];
    expect(photosFirst(list).map((e) => e.id)).toEqual(['b', 'a', 'c']);
    const films = [
      { id: 'x', posterUrl: null },
      { id: 'y', posterUrl: '/p.jpg' },
    ];
    expect(postersFirst(films).map((f) => f.id)).toEqual(['y', 'x']);
  });

  it('puts a DEMO film ahead of a TEST film that has a poster', () => {
    const films = [
      { id: 'test', posterUrl: '/p.jpg', contentLabel: 'TEST' as const },
      { id: 'demo', posterUrl: null, contentLabel: 'DEMO' as const },
    ];
    expect(postersFirst(films).map((f) => f.id)).toEqual(['demo', 'test']);
  });
});

describe('emptyStage', () => {
  it('says nothing is on sale anywhere when the unscoped listing is empty', () => {
    // PROD 2026-10-14: zero public events, yet the page said "Other places have events on sale".
    expect(emptyStage(0, 0)).toBe('nowhere');
  });

  it('ignores remembered city suggestions when nothing is on sale anywhere', () => {
    // A stale top-city count must not bring back a city chip that leads to nothing.
    expect(emptyStage(0, 3)).toBe('nowhere');
  });

  it('names cities when they have something on', () => {
    expect(emptyStage(12, 2)).toBe('cities');
  });

  it('claims other places sell only when the API counts events', () => {
    expect(emptyStage(5, 0)).toBe('elsewhere');
  });

  it('claims nothing while the global count is still loading', () => {
    expect(emptyStage(undefined, 0)).toBe('pending');
    expect(emptyStage(undefined, 4)).toBe('pending');
  });
});
