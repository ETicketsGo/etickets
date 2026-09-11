/**
 * Why a payment did not go through, in words a buyer can act on.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * Razorpay says exactly why a payment failed -- on QA, "this business accepts domestic
 * (Indian) card payments only" -- and the platform threw that away. The buyer saw "Payment was
 * cancelled" on screen and "We could not process the payment for booking cmtwoqn9g…" in their
 * inbox, retried the same card twice, and learned nothing either time.
 *
 * ── WHY OUR OWN CODES, NOT THE PROVIDER'S TEXT ─────────────────────────────────────
 * The provider's description is English, changes without notice, and is written for a
 * merchant. A small fixed set of reasons can be translated, shown the same way on the checkout
 * screen and in the notification, and cannot carry anything the buyer should not see. Anything
 * not recognised is UNKNOWN, which says "try again" rather than guessing at a cause.
 */
export const PaymentFailureReason = {
  INTERNATIONAL_CARD_NOT_ACCEPTED: 'INTERNATIONAL_CARD_NOT_ACCEPTED',
  CARD_DECLINED: 'CARD_DECLINED',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  AUTHENTICATION_FAILED: 'AUTHENTICATION_FAILED',
  CANCELLED: 'CANCELLED',
  TIMED_OUT: 'TIMED_OUT',
  BANK_UNAVAILABLE: 'BANK_UNAVAILABLE',
  METHOD_NOT_AVAILABLE: 'METHOD_NOT_AVAILABLE',
  UNKNOWN: 'UNKNOWN',
} as const;
export type PaymentFailureReason = (typeof PaymentFailureReason)[keyof typeof PaymentFailureReason];

/**
 * Own keys only. `value in PaymentFailureReason` also answered yes to "toString" and
 * "constructor", which would then be looked up as a translation key.
 */
export function isPaymentFailureReason(value: unknown): value is PaymentFailureReason {
  return (
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(PaymentFailureReason, value)
  );
}

/** The error a provider attaches to a failed payment. Every field is optional and untrusted. */
export interface ProviderPaymentError {
  code?: string | null;
  reason?: string | null;
  source?: string | null;
  step?: string | null;
}

/**
 * Razorpay's failure, reduced to a reason.
 *
 * Razorpay puts the specific cause in `error.reason` (snake_case, e.g.
 * `international_transaction_not_allowed`) and a broad class in `error.code`
 * (`BAD_REQUEST_ERROR`, `GATEWAY_ERROR`, `SERVER_ERROR`). The same object arrives on the
 * `payment.failed` webhook and on Checkout's `payment.failed` event, so both call this.
 *
 * Matched on the words that carry the meaning rather than an exact list, because Razorpay adds
 * reasons; the order matters -- "international ... not allowed" must be the international
 * case, not the generic "not allowed" one.
 */
export function razorpayFailureReason(
  error: ProviderPaymentError | null | undefined,
): PaymentFailureReason {
  const reason = String(error?.reason ?? '').toLowerCase();
  const code = String(error?.code ?? '').toUpperCase();
  const is = (pattern: RegExp) => pattern.test(reason);

  if (is(/international/)) return PaymentFailureReason.INTERNATIONAL_CARD_NOT_ACCEPTED;
  if (is(/insufficient/)) return PaymentFailureReason.INSUFFICIENT_FUNDS;
  if (is(/cancel/)) return PaymentFailureReason.CANCELLED;
  if (is(/timed_out|timeout/)) return PaymentFailureReason.TIMED_OUT;
  if (is(/otp|authenticat|3ds|verification/)) return PaymentFailureReason.AUTHENTICATION_FAILED;
  if (is(/not_(enabled|allowed|supported)|unsupported|method/)) {
    return PaymentFailureReason.METHOD_NOT_AVAILABLE;
  }
  if (
    is(/technical|server_error|gateway|unavailable|bank_down/) ||
    code === 'GATEWAY_ERROR' ||
    code === 'SERVER_ERROR'
  ) {
    return PaymentFailureReason.BANK_UNAVAILABLE;
  }
  if (is(/declin|blocked|risk|stolen|lost|expired|invalid|incorrect/)) {
    return PaymentFailureReason.CARD_DECLINED;
  }
  return PaymentFailureReason.UNKNOWN;
}
