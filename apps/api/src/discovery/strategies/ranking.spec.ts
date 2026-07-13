import {
  DEFAULT_RANK_WEIGHTS,
  popularityScore,
  rankBySignals,
  rankScore,
  soonnessScore,
  type RankSignals,
} from './ranking';

describe('popularityScore', () => {
  it('is 0 for no (or negative) bookings and saturates toward 1', () => {
    expect(popularityScore(0)).toBe(0);
    expect(popularityScore(-5)).toBe(0);
    expect(popularityScore(10)).toBeCloseTo(0.5, 5); // K = 10
    expect(popularityScore(1_000_000)).toBeGreaterThan(0.99);
  });

  it('is strictly increasing in bookings', () => {
    expect(popularityScore(5)).toBeLessThan(popularityScore(20));
  });
});

describe('soonnessScore', () => {
  const now = new Date('2026-07-13T12:00:00.000Z');

  it('is 0 for null, past, or unparseable sessions', () => {
    expect(soonnessScore(null, now)).toBe(0);
    expect(soonnessScore(new Date('2026-07-10T12:00:00.000Z'), now)).toBe(0);
    expect(soonnessScore('not-a-date', now)).toBe(0);
  });

  it('rewards sooner sessions over later ones', () => {
    const soon = new Date('2026-07-14T12:00:00.000Z'); // +1 day
    const later = new Date('2026-07-20T12:00:00.000Z'); // +7 days
    expect(soonnessScore(soon, now)).toBeGreaterThan(soonnessScore(later, now));
  });

  it('accepts ISO string dates', () => {
    expect(soonnessScore('2026-07-14T12:00:00.000Z', now)).toBeCloseTo(0.5, 5); // +1 day
  });
});

describe('rankScore', () => {
  const now = new Date('2026-07-13T12:00:00.000Z');

  it('blends popularity and soonness by the configured weights', () => {
    const signals: RankSignals = { bookings: 10, nextSessionAt: '2026-07-14T12:00:00.000Z' };
    // popularity .5 * .6 + soonness .5 * .4 = .5
    expect(rankScore(signals, now, DEFAULT_RANK_WEIGHTS)).toBeCloseTo(0.5, 5);
  });
});

describe('rankBySignals', () => {
  const now = new Date('2026-07-13T12:00:00.000Z');
  const items = [
    { id: 'a', bookings: 0, nextSessionAt: '2026-07-13T13:00:00.000Z' }, // very soon, unpopular
    { id: 'b', bookings: 100, nextSessionAt: '2026-07-14T12:00:00.000Z' }, // popular, +1 day
    { id: 'c', bookings: 2, nextSessionAt: null },
  ];
  const signalOf = (i: (typeof items)[number]) => ({
    bookings: i.bookings,
    nextSessionAt: i.nextSessionAt,
  });

  it('orders by blended score (popular event outranks a merely-soon one)', () => {
    const order = rankBySignals(items, signalOf, now).map((i) => i.id);
    expect(order[0]).toBe('b');
    expect(order).toEqual(['b', 'a', 'c']);
  });

  it('with popularity-only weights orders purely by bookings', () => {
    const order = rankBySignals(items, signalOf, now, { popularity: 1, soonness: 0 }).map(
      (i) => i.id,
    );
    expect(order).toEqual(['b', 'c', 'a']);
  });

  it('does not mutate the input array', () => {
    const before = items.map((i) => i.id);
    rankBySignals(items, signalOf, now);
    expect(items.map((i) => i.id)).toEqual(before);
  });
});
