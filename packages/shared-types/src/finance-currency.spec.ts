import { describe, it, expect } from 'vitest';
import { readCurrency, sameCurrency, groupByCurrency, CURRENCY_WILDCARD } from './finance-currency';

/**
 * The case these tests exist for: this platform really does store `INR` and `inr` for the same
 * money, in different tables, on purpose. Everything here is written against that fact.
 */
describe('readCurrency', () => {
  it('folds the case the two systems disagree on', () => {
    // Settlement and Dispute store lowercase; everything else stores uppercase.
    expect(readCurrency('inr')).toBe('INR');
    expect(readCurrency('usd')).toBe('USD');
    expect(readCurrency('INR')).toBe('INR');
  });

  it('keeps the wildcard, which is a rule scope and not a currency', () => {
    expect(readCurrency(CURRENCY_WILDCARD)).toBe(CURRENCY_WILDCARD);
  });

  it('returns null rather than guessing when there is nothing to read', () => {
    // A default here would file money under a currency nobody stated.
    expect(readCurrency(null)).toBeNull();
    expect(readCurrency(undefined)).toBeNull();
    expect(readCurrency('')).toBeNull();
    expect(readCurrency('   ')).toBeNull();
  });

  it('trims, because a stored value may carry whitespace', () => {
    expect(readCurrency(' inr ')).toBe('INR');
  });
});

describe('sameCurrency', () => {
  it('matches the same money stored by either system', () => {
    // This is the comparison that splits an organizer's money in half when it is missing.
    expect(sameCurrency('INR', 'inr')).toBe(true);
    expect(sameCurrency('usd', 'USD')).toBe(true);
  });

  it('does not match different currencies', () => {
    expect(sameCurrency('INR', 'USD')).toBe(false);
  });

  it('never matches an unknown value', () => {
    expect(sameCurrency('INR', null)).toBe(false);
    expect(sameCurrency(null, null)).toBe(false);
    expect(sameCurrency('INR', '')).toBe(false);
  });

  it('never lets the wildcard equate two currencies', () => {
    /*
      "Applies to any currency" belongs to a RULE, and the routing layer answers it. If it
      matched here, an INR total would compare equal to a USD one.
    */
    expect(sameCurrency(CURRENCY_WILDCARD, 'INR')).toBe(false);
    expect(sameCurrency('INR', CURRENCY_WILDCARD)).toBe(false);
    expect(sameCurrency(CURRENCY_WILDCARD, CURRENCY_WILDCARD)).toBe(false);
  });
});

describe('groupByCurrency', () => {
  it('puts both spellings of one currency in one bucket', () => {
    const rows = [
      { id: 'payout', currency: 'INR' },
      { id: 'settlement', currency: 'inr' },
      { id: 'other', currency: 'USD' },
    ];
    const grouped = groupByCurrency(rows, (r) => r.currency);

    expect([...grouped.keys()].sort()).toEqual(['INR', 'USD']);
    expect(grouped.get('INR')?.map((r) => r.id)).toEqual(['payout', 'settlement']);
  });

  it('is the exact failure a naive group would produce', () => {
    /*
      Kept as a test because the bug is invisible once it happens: two buckets, each with a
      plausible total, and nothing on screen saying they are the same currency.
    */
    const rows = [{ currency: 'INR' }, { currency: 'inr' }];
    const naive = new Map<string, unknown[]>();
    for (const r of rows) naive.set(r.currency, [...(naive.get(r.currency) ?? []), r]);

    expect(naive.size).toBe(2);
    expect(groupByCurrency(rows, (r) => r.currency).size).toBe(1);
  });

  it('drops rows that name no currency rather than inventing a bucket', () => {
    const rows = [{ currency: 'INR' }, { currency: null }, { currency: '' }];
    const grouped = groupByCurrency(rows, (r) => r.currency);
    expect([...grouped.keys()]).toEqual(['INR']);
  });

  it('drops the wildcard, which is not money', () => {
    const rows = [{ currency: 'INR' }, { currency: CURRENCY_WILDCARD }];
    expect([...groupByCurrency(rows, (r) => r.currency).keys()]).toEqual(['INR']);
  });

  it('keeps every row of a bucket, in the order given', () => {
    const rows = [
      { id: 1, c: 'inr' },
      { id: 2, c: 'INR' },
      { id: 3, c: 'Inr' },
    ];
    expect(
      groupByCurrency(rows, (r) => r.c)
        .get('INR')
        ?.map((r) => r.id),
    ).toEqual([1, 2, 3]);
  });
});
