/**
 * A discount code's value, between what an organizer types and what the API stores.
 *
 * ── THE BUG THIS EXISTS FOR ───────────────────────────────────────────────────────
 * A FIXED code's `value` is in MINOR units: the pricing engine subtracts it from a subtotal in
 * paise or cents unchanged. The form asked for "Amount (₹)" as a whole number and sent that
 * number as it was, so a code created as ₹100 off took ₹1 off. PERCENT codes were right and
 * stay unchanged — their value is a percentage, not money.
 *
 * Every currency this platform sells in (INR, USD, CAD) has two decimal places, so one major
 * unit is 100 minor units.
 */
export type CouponValueType = 'PERCENT' | 'FIXED';

const MINOR_PER_MAJOR = 100;

/** What to send as `value`. Call only once `couponValueError` has returned null. */
export function couponValueToApi(type: CouponValueType, input: string): number {
  const n = Number(input);
  return type === 'FIXED' ? Math.round(n * MINOR_PER_MAJOR) : n;
}

/** What the edit form shows for a stored `value`. */
export function couponValueToInput(type: CouponValueType, value: number): string {
  return String(type === 'FIXED' ? value / MINOR_PER_MAJOR : value);
}

/** Why the typed value cannot be saved, or null when it can. */
export function couponValueError(type: CouponValueType, input: string): string | null {
  const n = Number(input);
  if (type === 'PERCENT') {
    if (input.trim() === '' || !Number.isInteger(n) || n <= 0) return 'Enter a whole number > 0.';
    if (n > 100) return 'Percentage must be 1–100.';
    return null;
  }
  if (input.trim() === '' || !Number.isFinite(n) || n <= 0) {
    return 'Enter an amount greater than 0.';
  }
  // Precision the currency does not have would be rounded away silently; say so instead.
  if (Math.abs(n * MINOR_PER_MAJOR - Math.round(n * MINOR_PER_MAJOR)) > 1e-6) {
    return 'Use at most two decimal places.';
  }
  return null;
}

/**
 * The currencies an organization sells in, from its venues' currencies, most venues first.
 *
 * These are the only currencies a fixed discount can usefully be written in: a FIXED code
 * applies only to bookings in its own currency, and a booking is in its venue's. A venue whose
 * country has no known currency adds nothing. Equal counts keep the order they were first met
 * in, because `Array.prototype.sort` is stable.
 */
export function sellingCurrencies(venueCurrencies: (string | null | undefined)[]): string[] {
  const counts = new Map<string, number>();
  for (const c of venueCurrencies) if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([c]) => c);
}

/**
 * The currency a new fixed amount starts in, from the currencies the organization's venues sell in.
 *
 * The most common among their venues, with `mixed` saying there are others to choose from.
 * Before there is a venue nothing has been sold, and INR is the default everywhere else in this
 * console.
 */
export function couponCurrency(venueCurrencies: (string | null | undefined)[]): {
  currency: string;
  mixed: boolean;
} {
  const currencies = sellingCurrencies(venueCurrencies);
  return { currency: currencies[0] ?? 'INR', mixed: currencies.length > 1 };
}

/**
 * The currency a stored coupon's fixed amount is in.
 *
 * A code created before coupons carried a currency has none, and the checkout applies such a
 * code to rupee bookings only — so that is what it is shown in, rather than a guess from venues.
 */
export function storedCouponCurrency(currency: string | null | undefined): string {
  return currency ?? 'INR';
}
