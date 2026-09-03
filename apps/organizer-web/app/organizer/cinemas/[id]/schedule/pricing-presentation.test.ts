import { describe, expect, it } from 'vitest';
import type { ShowPricing } from '@eticketsgo/web-kit';
import {
  changedRows,
  differsFromHouse,
  formatMinor,
  lockReason,
  minorToInput,
  parseDraft,
  showLockReason,
} from './pricing-presentation';

/**
 * These are about money, so they are about the edges: a blank field, a third decimal, a
 * category that has sold. Anything that could turn a typo into a free seat.
 */
const cat = (over: Partial<ShowPricing['categories'][number]> = {}) => ({
  ticketTypeId: 'tt1',
  seatCategoryId: 'sc1',
  name: 'PREMIUM',
  colorHex: null,
  currency: 'INR',
  priceMinor: 30000,
  basePriceMinor: 30000,
  seatCount: 40,
  soldCount: 0,
  heldCount: 0,
  locked: false,
  ...over,
});

const pricing = (categories: ShowPricing['categories']): ShowPricing => ({
  sessionId: 's1',
  startsAt: '2031-01-01T12:30:00.000Z',
  endsAt: '2031-01-01T14:30:00.000Z',
  status: 'SCHEDULED',
  screenName: 'Screen 1',
  cinemaId: 'c1',
  timezone: 'Asia/Kolkata',
  movieTitle: 'A Film',
  categories,
});

describe('reading what the operator typed', () => {
  it('turns rupees into paise', () => {
    const p = pricing([cat()]);
    expect(parseDraft(p, { tt1: '350' }).prices).toEqual([
      { ticketTypeId: 'tt1', priceMinor: 35000 },
    ]);
    expect(parseDraft(p, { tt1: '350.50' }).prices).toEqual([
      { ticketTypeId: 'tt1', priceMinor: 35050 },
    ]);
  });

  it('refuses a blank field rather than reading it as free', () => {
    // `Number('')` is 0. Left alone, an operator who cleared a field to retype it and then
    // hit Save would have given the seat away.
    const r = parseDraft(pricing([cat()]), { tt1: '   ' });
    expect(r.prices).toEqual([]);
    expect(r.problems[0].message).toContain('Enter a price for PREMIUM');
  });

  it.each(['abc', '1e5', '-50', '35.005', '3,50', '₹350'])('refuses %s', (raw) => {
    const r = parseDraft(pricing([cat()]), { tt1: raw });
    expect(r.prices).toEqual([]);
    expect(r.problems).toHaveLength(1);
  });

  it('accepts zero, because a free preview is a real thing', () => {
    // Refused later by readiness if the show is actually on sale — a decision, not a typo.
    expect(parseDraft(pricing([cat()]), { tt1: '0' }).prices).toEqual([
      { ticketTypeId: 'tt1', priceMinor: 0 },
    ]);
  });

  it('refuses an absurd amount before the server has to', () => {
    expect(parseDraft(pricing([cat()]), { tt1: '200000' }).problems[0].message).toContain(
      'too high',
    );
  });

  it('an untouched field keeps its current price', () => {
    expect(parseDraft(pricing([cat()]), {}).prices).toEqual([
      { ticketTypeId: 'tt1', priceMinor: 30000 },
    ]);
  });

  it('one bad row does not discard the good ones, and each says which it is', () => {
    const p = pricing([cat(), cat({ ticketTypeId: 'tt2', name: 'STANDARD', priceMinor: 20000 })]);
    const r = parseDraft(p, { tt1: 'oops', tt2: '250' });
    expect(r.prices).toEqual([{ ticketTypeId: 'tt2', priceMinor: 25000 }]);
    expect(r.problems[0].message).toContain('PREMIUM');
  });

  it('a sold category is submitted unchanged rather than left out', () => {
    // The endpoint takes the whole show. Omitting a row would read as "no opinion" when the
    // operator's opinion is "as it was" — and a draft value for it must not sneak through.
    const p = pricing([cat({ locked: true, soldCount: 4 })]);
    expect(parseDraft(p, { tt1: '999' }).prices).toEqual([
      { ticketTypeId: 'tt1', priceMinor: 30000 },
    ]);
  });
});

describe('deciding whether Save does anything', () => {
  it('reports only the rows that moved', () => {
    const p = pricing([cat(), cat({ ticketTypeId: 'tt2', name: 'STANDARD', priceMinor: 20000 })]);
    const { prices } = parseDraft(p, { tt1: '300', tt2: '250' });
    expect(changedRows(p, prices)).toEqual([{ ticketTypeId: 'tt2', priceMinor: 25000 }]);
  });

  it('retyping the same number is not a change', () => {
    const p = pricing([cat()]);
    expect(changedRows(p, parseDraft(p, { tt1: '300.00' }).prices)).toEqual([]);
  });
});

describe('explaining what cannot be edited', () => {
  it('a sold category says how many and at what price', () => {
    expect(lockReason(cat({ locked: true, soldCount: 1, priceMinor: 30000 }))).toBe(
      '1 seat has sold at ₹300, so this price is fixed for this show.',
    );
    expect(lockReason(cat({ locked: true, soldCount: 7 }))).toContain('7 seats have sold');
  });

  it('an editable category has nothing to explain', () => {
    expect(lockReason(cat())).toBeNull();
  });

  it('a started show is closed to repricing', () => {
    const p = pricing([cat()]);
    expect(showLockReason(p, new Date('2031-01-01T13:00:00Z'))).toContain('already started');
    expect(showLockReason(p, new Date('2030-12-01T00:00:00Z'))).toBeNull();
  });

  it('a cancelled show is closed even if it is in the future', () => {
    const p = { ...pricing([cat()]), status: 'CANCELLED' };
    expect(showLockReason(p, new Date('2030-12-01T00:00:00Z'))).toContain('cancelled');
  });
});

describe('showing when tonight differs from the house price', () => {
  it('says so, because the layout is what the NEXT show inherits', () => {
    expect(differsFromHouse(cat({ priceMinor: 35000, basePriceMinor: 30000 }))).toBe(
      'House price ₹300',
    );
  });

  it('says nothing when they agree', () => {
    expect(differsFromHouse(cat({ priceMinor: 30000, basePriceMinor: 30000 }))).toBeNull();
  });
});

describe('formatting', () => {
  it('round-trips through the input without drifting', () => {
    for (const minor of [0, 1, 99, 100, 25050, 100_000_00]) {
      expect(
        parseDraft(pricing([cat({ priceMinor: 0 })]), { tt1: minorToInput(minor) }).prices[0]
          .priceMinor,
      ).toBe(minor);
    }
  });

  it('uses Indian grouping, since that is who reads it', () => {
    expect(formatMinor(100_000_00)).toBe('₹1,00,000');
  });

  it('shows paise only when the price HAS paise', () => {
    /*
      This screen used to print two decimals always while the storefront printed none, and
      they were two of five copies of the same decision. Both now call one formatter: a
      whole-rupee price is ₹250, and a price carrying paise says so rather than being
      rounded into a number nobody is charging.
    */
    expect(formatMinor(250_00)).toBe('₹250');
    expect(formatMinor(250_50)).toBe('₹250.50');
    expect(formatMinor(250_05)).toBe('₹250.05');
  });

  it('still writes two decimals into the EDIT field, which is a different job', () => {
    // An operator types into a bare number input; "250.00" tells them the field takes paise.
    // Display and input are allowed to differ, and here they should.
    expect(minorToInput(250_00)).toBe('250.00');
  });
});
