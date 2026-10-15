import { describe, expect, it } from 'vitest';
import type { SeatClassMapping } from '@eticketsgo/web-kit';
import { currencySign, limitHint, minorToField, parseRunPrices, runPriceRows } from './run-pricing';

/**
 * A run is priced before it is created. The legal limit is the server's answer; these pin how
 * it is read and said, and that a blank field is never read as "free".
 */
const AP_RATES: NonNullable<SeatClassMapping['classRates']> = [
  {
    regulatoryClass: 'REGULAR',
    regulated: true,
    sellable: true,
    maxMinor: 15_000,
    minMinor: null,
    regulatoryReference: 'G.O.13',
    status: 'REQUIRES_APPROVAL',
  },
  {
    regulatoryClass: 'RECLINER',
    regulated: true,
    sellable: true,
    maxMinor: 25_000,
    minMinor: null,
    regulatoryReference: 'G.O.13',
    status: 'REQUIRES_APPROVAL',
  },
  {
    regulatoryClass: 'PREMIUM',
    regulated: true,
    sellable: false,
    maxMinor: null,
    minMinor: null,
    regulatoryReference: null,
    status: 'REQUIRES_APPROVAL',
  },
  {
    regulatoryClass: 'NON_PREMIUM',
    regulated: true,
    sellable: false,
    maxMinor: null,
    minMinor: null,
    regulatoryReference: null,
    status: 'REQUIRES_APPROVAL',
  },
];

const map = {
  categories: [
    { id: 'reg', name: 'Stalls', colorHex: null, basePriceMinor: 15_000 },
    { id: 'rec', name: 'Lounge', colorHex: null, basePriceMinor: 25_000 },
    { id: 'plat', name: 'Platinum Executive', colorHex: null, basePriceMinor: 20_000 },
  ],
};
const classes = (rates = AP_RATES): SeatClassMapping[] =>
  (
    [
      ['reg', 'Stalls', 'REGULAR'],
      ['rec', 'Lounge', 'RECLINER'],
      ['plat', 'Platinum Executive', null],
    ] as const
  ).map(([id, name, cls]) => ({
    id,
    name,
    regulatoryClass: cls,
    basePriceMinor: 0,
    currency: 'INR',
    mapped: cls != null,
    classRates: rates,
  }));

describe('runPriceRows', () => {
  it('starts every category at its house price, with its class and limit', () => {
    const rows = runPriceRows(map, classes());
    expect(rows.map((r) => [r.name, r.houseMinor, r.className, r.maxMinor, r.sellable])).toEqual([
      ['Stalls', 15_000, 'Regular', 15_000, true],
      ['Lounge', 25_000, 'Recliner', 25_000, true],
      // Unmapped where an order applies: it will not sell, whatever its price.
      ['Platinum Executive', 20_000, null, null, false],
    ]);
  });

  it('has no limits where no order applies', () => {
    const rows = runPriceRows(map, classes([]));
    expect(rows.every((r) => !r.regulated && r.sellable && r.maxMinor === null)).toBe(true);
    expect(rows.map(limitHint)).toEqual([null, null, null]);
  });
});

describe('limitHint', () => {
  it('says the limit, and why an unmapped or unrated seat will not sell', () => {
    const [stalls, , plat] = runPriceRows(map, classes());
    expect(limitHint(stalls!)).toBe('Legal limit for a Regular seat here: up to ₹150.');
    expect(limitHint(plat!)).toMatch(/Not mapped to a seat class, so these seats will not sell/);
  });
});

describe('parseRunPrices', () => {
  const rows = runPriceRows(map, classes());

  it('sends every category at what the field shows, house price by default', () => {
    expect(parseRunPrices(rows, { rec: '240' })).toEqual({
      pricing: [
        { seatCategoryId: 'reg', priceMinor: 15_000 },
        { seatCategoryId: 'rec', priceMinor: 24_000 },
        { seatCategoryId: 'plat', priceMinor: 20_000 },
      ],
      problems: [],
    });
  });

  it('flags a price over the limit in words, and leaves it out', () => {
    const r = parseRunPrices(rows, { rec: '300' });
    expect(r.problems).toEqual([
      { seatCategoryId: 'rec', message: 'Lounge: at most ₹250 for a Recliner seat here.' },
    ]);
    expect(r.pricing.map((p) => p.seatCategoryId)).toEqual(['reg', 'plat']);
  });

  it('refuses blank and malformed prices rather than reading them as free', () => {
    const r = parseRunPrices(rows, { reg: '', rec: '12.345' });
    expect(r.problems.map((p) => p.seatCategoryId)).toEqual(['reg', 'rec']);
  });
});

describe('formatting', () => {
  it('shows whole rupees plainly and keeps paise', () => {
    expect(minorToField(15_000)).toBe('150');
    expect(minorToField(15_050)).toBe('150.50');
  });
  it('labels a field with its own currency', () => {
    expect(currencySign('INR')).toBe('₹');
    expect(currencySign('USD')).toBe('$');
  });
});
