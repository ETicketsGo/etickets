import { describe, expect, it } from 'vitest';
import {
  formatRatingAverage,
  formatVoteCount,
  hasRating,
  ratingDistribution,
  roundedStars,
} from './ratings';

/** French separates with narrow or no-break spaces; the assertions care about the words. */
const plain = (s: string) => s.replace(/[  ]/g, ' ');

describe('hasRating', () => {
  it('shows a rating only when somebody rated', () => {
    expect(hasRating({ average: 4.3, count: 12 })).toBe(true);
    // "0/5" reads as "terrible", not "unrated".
    expect(hasRating({ average: 0, count: 0 })).toBe(false);
    expect(hasRating(null)).toBe(false);
    // An older API sends no field at all.
    expect(hasRating(undefined)).toBe(false);
  });
});

describe('formatVoteCount', () => {
  it('keeps exact numbers below a thousand', () => {
    expect(formatVoteCount(0)).toBe('0');
    expect(formatVoteCount(1)).toBe('1');
    expect(formatVoteCount(999)).toBe('999');
  });

  it('abbreviates from a thousand up', () => {
    expect(formatVoteCount(1000)).toBe('1K');
    expect(formatVoteCount(1234)).toBe('1.2K');
    expect(formatVoteCount(22_450)).toBe('22.4K');
    expect(formatVoteCount(1_500_000)).toBe('1.5M');
  });

  it('never overstates by rounding up', () => {
    // 1,199 people is not "1.2K" people.
    expect(formatVoteCount(1199)).toBe('1.1K');
    expect(formatVoteCount(999_999)).toBe('999.9K');
  });

  it('formats in French', () => {
    expect(plain(formatVoteCount(1234, 'fr-CA'))).toBe('1,2 k');
    expect(plain(formatVoteCount(640, 'fr-CA'))).toBe('640');
  });

  it('survives nonsense without throwing', () => {
    expect(formatVoteCount(Number.NaN)).toBe('0');
    expect(formatVoteCount(-5)).toBe('0');
  });
});

describe('formatRatingAverage', () => {
  it('shows one decimal, including a whole number', () => {
    expect(formatRatingAverage(4.3)).toBe('4.3');
    expect(formatRatingAverage(5)).toBe('5.0');
    expect(formatRatingAverage(3.96)).toBe('4.0');
  });

  it('uses the French decimal comma', () => {
    expect(formatRatingAverage(4.3, 'fr-CA')).toBe('4,3');
  });

  it('stays on the 5-point scale', () => {
    expect(formatRatingAverage(7)).toBe('5.0');
    expect(formatRatingAverage(Number.NaN)).toBe('0.0');
  });
});

describe('roundedStars', () => {
  it('rounds to whole stars within the scale', () => {
    expect(roundedStars(4.3)).toBe(4);
    expect(roundedStars(4.5)).toBe(5);
    expect(roundedStars(9)).toBe(5);
    expect(roundedStars(Number.NaN)).toBe(0);
  });
});

describe('ratingDistribution', () => {
  it('orders the buckets 5 to 1 with their counts', () => {
    const rows = ratingDistribution({ '5': 6, '4': 3, '3': 1, '2': 0, '1': 0 });
    expect(rows.map((r) => r.stars)).toEqual([5, 4, 3, 2, 1]);
    expect(rows.map((r) => r.count)).toEqual([6, 3, 1, 0, 0]);
    expect(rows.map((r) => r.percent)).toEqual([60, 30, 10, 0, 0]);
  });

  it('adds up to exactly 100 when rounding would not', () => {
    // Independent rounding gives 33 + 33 + 33 = 99.
    const rows = ratingDistribution({ '5': 1, '4': 1, '3': 1 });
    expect(rows.reduce((sum, r) => sum + r.percent, 0)).toBe(100);
    expect(rows.map((r) => r.percent)).toEqual([34, 33, 33, 0, 0]);

    const uneven = ratingDistribution({ '5': 7, '4': 5, '3': 2, '2': 1, '1': 1 });
    expect(uneven.reduce((sum, r) => sum + r.percent, 0)).toBe(100);
  });

  it('is all zeros when nobody rated, and ignores junk', () => {
    expect(ratingDistribution({}).every((r) => r.percent === 0 && r.count === 0)).toBe(true);
    expect(ratingDistribution(null).every((r) => r.percent === 0)).toBe(true);
    const junk = ratingDistribution({ '5': -3, '4': Number.NaN, '3': 2 });
    expect(junk.map((r) => r.count)).toEqual([0, 0, 2, 0, 0]);
    expect(junk.map((r) => r.percent)).toEqual([0, 0, 100, 0, 0]);
  });
});
