import { describe, it, expect } from 'vitest';
import { money, moneyFractionDigits, currencySymbol } from './format';

/**
 * One money formatter, and the rule it follows.
 *
 * ── WHAT WAS WRONG ─────────────────────────────────────────────────────────────────
 * There were five. For a cart of ₹355.22 they said:
 *
 *     storefront / mobile        ₹355        (INR pinned to whole rupees)
 *     receipt                    ₹355.22     (Intl default, and ₹104,040 grouping)
 *     notification emails        ₹355.22     (Intl default, but ₹1,04,040 grouping)
 *     organizer — live seats     ₹355        (whole rupees again)
 *     organizer — show pricing   ₹355.22     (two decimals always)
 *
 * The customer-visible half of that was the worst of it: the storefront showed ₹355 for a
 * booking the receipt charged ₹355.22 at. The platform displayed a number nobody was paying.
 *
 * The file's own header comment had warned that a second implementation of the INR rule
 * "is exactly the kind of thing that drifts silently". It was right; there were four.
 */
describe('the INR rule: paise appear exactly when there are paise', () => {
  it('keeps a whole-rupee amount clean', () => {
    // The reason INR was special-cased in the first place, and it was a good reason. Indian
    // ticket prices are whole rupees and "₹799.00" is noise on a listing.
    expect(money(79_900)).toBe('₹799');
    expect(money(0)).toBe('₹0');
  });

  it('shows the paise when the amount HAS paise — the bug', () => {
    // ₹355.22 was printed "₹355". A displayed amount must never differ from the charged one.
    expect(money(35_522)).toBe('₹355.22');
  });

  it('keeps a trailing zero rather than printing ₹47.2', () => {
    // Two digits or none. One is not a thing money does.
    expect(money(4_720)).toBe('₹47.20');
  });

  it('groups in lakhs, which is who this is for', () => {
    expect(money(1_00_00_000)).toBe('₹1,00,000');
    expect(money(1_00_00_050)).toBe('₹1,00,000.50');
  });
});

describe('every other currency keeps its sub-unit, always', () => {
  it('does not collapse $9.99 and $10.00 into the same string', () => {
    /*
      The INR rule must not leak. A table of fee bands where $9.99 and $10.00 both render
      "$10" is a table an admin cannot use — telling adjacent bands apart is its entire job.
    */
    expect(money(999, 'USD')).toBe('$9.99');
    expect(money(1_000, 'USD')).toBe('$10.00');
  });

  it('asks Intl how many digits a currency has instead of assuming two', () => {
    // JPY has no sub-unit. The old code hardcoded minimumFractionDigits: 2 for everything
    // that was not INR, and rendered ¥1,234.56 for a currency that cannot have .56.
    expect(money(123_400, 'JPY')).not.toContain('.');
  });

  it('shows the amount rather than throwing when the currency code is bad', () => {
    /*
      This runs inside a render, so a RangeError blanks a page over a typo'd code.

      Two different cases, and only one reaches the fallback: `Intl` accepts any well-formed
      three-letter code and formats it (with a non-breaking space, hence the regex), and
      throws only on a malformed one.
    */
    expect(money(35_522, 'ZZZ')).toMatch(/^ZZZ\s355\.22$/);
    expect(money(35_522, 'ZZ')).toBe('ZZ 355.22');
  });

  it('still renders an em dash for nothing at all', () => {
    expect(money(null)).toBe('—');
    expect(money(undefined)).toBe('—');
  });
});

describe('a document decides once, for the whole column', () => {
  /*
    Per-amount decisions print "₹300" above "₹55.22": the decimal points do not line up and
    the first row reads as a different kind of number from the second.
  */
  it('gives every row paise when ANY row has paise', () => {
    const rows = [30_000, 5_522, 35_522];
    const digits = moneyFractionDigits(rows, 'INR');
    expect(rows.map((r) => money(r, 'INR', undefined, digits))).toEqual([
      '₹300.00',
      '₹55.22',
      '₹355.22',
    ]);
  });

  it('leaves an all-whole-rupee document clean', () => {
    // Most carts. Forcing "₹300.00" everywhere would be the opposite mistake.
    const rows = [30_000, 5_000, 35_000];
    const digits = moneyFractionDigits(rows, 'INR');
    expect(rows.map((r) => money(r, 'INR', undefined, digits))).toEqual(['₹300', '₹50', '₹350']);
  });

  it('ignores gaps in the document rather than treating them as zero', () => {
    expect(moneyFractionDigits([30_000, null, undefined], 'INR')).toBe(0);
    expect(moneyFractionDigits([30_000, null, 5_522], 'INR')).toBe(2);
  });

  it('has nothing to decide for a currency that always shows its sub-unit', () => {
    expect(moneyFractionDigits([30_000, 5_000], 'USD')).toBe(2);
  });
});

describe('the surfaces that used to disagree now cannot', () => {
  it('prints the same string for the storefront and the receipt', () => {
    /*
      The reported defect, as an assertion. Both surfaces call this function; there is no
      longer a second implementation for one of them to drift into.
    */
    expect(money(35_522, 'INR')).toBe('₹355.22');
  });

  it('groups INR the same way in English regardless of who asks', () => {
    // The receipt used plain `en` (₹104,040) while the emails used en-IN (₹1,04,040). An
    // explicit locale still wins, for the French documents that need it.
    expect(money(1_04_04_000, 'INR')).toBe('₹1,04,040');
    expect(money(1_04_04_000, 'INR', 'fr-CA')).toContain('104');
  });

  it('leaves the currency symbol helper alone', () => {
    expect(currencySymbol('INR')).toBe('₹');
    expect(currencySymbol('USD')).toBe('$');
  });
});
