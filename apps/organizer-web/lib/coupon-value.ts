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
 * The currency to label a fixed amount in, from the currencies the organization's venues sell in.
 *
 * A code has no currency of its own: it comes off whatever booking it is applied to, in that
 * booking's currency. So the honest label is the currency the organizer sells in — the most
 * common among their venues — and `mixed` says when that is not the whole story. Before there
 * is a venue nothing has been sold, and INR is the default everywhere else in this console.
 */
export function couponCurrency(venueCurrencies: (string | null | undefined)[]): {
  currency: string;
  mixed: boolean;
} {
  const counts = new Map<string, number>();
  for (const c of venueCurrencies) if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  let currency = 'INR';
  let best = 0;
  for (const [c, n] of counts) {
    if (n > best) {
      currency = c;
      best = n;
    }
  }
  return { currency, mixed: counts.size > 1 };
}
