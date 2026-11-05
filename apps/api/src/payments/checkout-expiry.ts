/**
 * When a hosted checkout (Stripe Checkout) should stop accepting payment.
 *
 * ── THE MISMATCH THIS RECONCILES ──────────────────────────────────────────────────────
 * A booking hold lasts minutes (BOOKING_HOLD_MINUTES, default 10). Stripe Checkout refuses an
 * `expires_at` sooner than 30 minutes away, and without one a session stays payable for 24
 * hours. So the checkout cannot be made to end with the hold. Instead:
 *
 *   1. the session gets the SHORTEST deadline Stripe accepts that still covers the hold, and
 *   2. when the hold lapses, the expiry sweep CLOSES the session before releasing anything
 *      (PendingPaymentRecoveryService.guardExpiry), and only releases when Stripe confirms
 *      it is closed and unpaid.
 *
 * The deadline is rounded up to a 5-minute boundary so that repeated "pay" calls within the
 * same few minutes send Stripe identical parameters under the same idempotency key, and get
 * the same session back rather than a second payable one.
 */
export const STRIPE_MIN_CHECKOUT_MS = 30 * 60_000;
const MARGIN_MS = 60_000;
const BUCKET_MS = 5 * 60_000;
const MAX_MS = 23 * 60 * 60_000;

export function checkoutExpiry(holdExpiresAt: Date, now: Date = new Date()): Date {
  const floor = now.getTime() + STRIPE_MIN_CHECKOUT_MS + MARGIN_MS;
  const wanted = Math.max(floor, holdExpiresAt.getTime() + MARGIN_MS);
  const bucketed = Math.ceil(wanted / BUCKET_MS) * BUCKET_MS;
  return new Date(Math.min(bucketed, now.getTime() + MAX_MS));
}
