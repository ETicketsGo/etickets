import { describe, it, expect } from 'vitest';
import {
  currencySymbol,
  dateOnly,
  dateTime,
  formatFor,
  money,
  moneyFractionDigits,
  zoneAbbrev,
} from './format';

/**
 * Formatting in the reader's language.
 *
 * French customers saw "19 Sept 2026, 6:30 pm" and "₹1,039.60" in the middle of French copy.
 * `formatFor` binds the formatters to the UI locale — and must not move a single byte of the
 * English output, which receipts, e2e money-footing assertions and every other test read.
 */

/** 6:30 pm in Asia/Kolkata. */
const SHOW = '2026-09-19T13:00:00.000Z';
const ZONE = 'Asia/Kolkata';

/** French puts no-break spaces in numbers and before symbols; compare them as spaces. */
const plain = (s: string) => s.replace(/[  ]/g, ' ');

describe('English is exactly what it always was', () => {
  it.each([undefined, null, 'en', 'en-US', 'en-IN'])('%s returns the module functions', (l) => {
    const f = formatFor(l);
    expect(f.locale).toBeUndefined();
    expect(f.money).toBe(money);
    expect(f.moneyFractionDigits).toBe(moneyFractionDigits);
    expect(f.currencySymbol).toBe(currencySymbol);
    expect(f.dateTime).toBe(dateTime);
    expect(f.dateOnly).toBe(dateOnly);
    expect(f.zoneAbbrev).toBe(zoneAbbrev);
  });

  it('keeps the English strings', () => {
    const f = formatFor('en');
    expect(f.money(1_039_60, 'INR')).toBe('₹1,039.60');
    expect(f.money(79_900, 'INR')).toBe('₹799');
    expect(f.money(1_234_56, 'USD')).toBe('$1,234.56');
    expect(f.dateTime(SHOW, undefined, ZONE)).toBe(dateTime(SHOW, 'en-IN', ZONE));
    expect(f.dateTime(SHOW, undefined, ZONE)).toMatch(/6:30\s?pm/i);
  });
});

describe('fr-CA formats in French', () => {
  const f = formatFor('fr-CA');

  it('binds the locale', () => {
    expect(f.locale).toBe('fr-CA');
    // One object per locale: the same formatters on every render, on server and client.
    expect(formatFor('fr-CA')).toBe(f);
  });

  it('writes rupees the French way, with the rupee sign rather than "INR"', () => {
    expect(plain(f.money(1_039_60, 'INR'))).toBe('1 039,60 ₹');
    expect(plain(f.money(79_900, 'INR'))).toBe('799 ₹');
  });

  it('keeps US dollars distinguishable from Canadian dollars', () => {
    // A bare "$" means CAD in Quebec. narrowSymbol would have printed both the same way.
    expect(plain(f.money(1_234_56, 'USD'))).toBe('1 234,56 $ US');
    expect(plain(f.money(1_234_56, 'CAD'))).toBe('1 234,56 $');
    expect(plain(f.currencySymbol('USD'))).toBe('$ US');
    expect(f.currencySymbol('INR')).toBe('₹');
  });

  it('keeps the fraction-digit rule and the placeholder for a missing amount', () => {
    expect(plain(f.money(1_000_00, 'INR', undefined, 2))).toBe('1 000,00 ₹');
    expect(f.moneyFractionDigits([35_522, 30_000], 'INR')).toBe(2);
    expect(f.money(null, 'INR')).toBe('—');
  });

  it('lets an explicit locale win', () => {
    expect(f.money(1_039_60, 'INR', 'en-IN')).toBe('₹1,039.60');
  });

  it('shows an unknown currency rather than throwing', () => {
    expect(f.money(100, 'ZZZ')).toContain('ZZZ');
  });

  it('writes dates with French month names and a 24-hour clock, in the venue zone', () => {
    const when = plain(f.dateTime(SHOW, undefined, ZONE));
    expect(when).toContain('19 sept. 2026');
    expect(when).toContain('18 h 30');
    expect(when).not.toMatch(/pm/i);
    expect(plain(f.dateOnly(SHOW, undefined, ZONE))).toBe('19 sept. 2026');
  });

  it('leaves the zone abbreviation as the venue prints it', () => {
    expect(f.zoneAbbrev(SHOW, ZONE)).toBe(zoneAbbrev(SHOW, ZONE));
  });
});
