import {
  PaymentFailureReason,
  isPaymentFailureReason,
  razorpayFailureReason,
} from '@eticketsgo/shared-types';

/**
 * Razorpay's refusal, reduced to something a buyer can act on.
 *
 * The cases are Razorpay's own `error.reason` tokens. The one that matters most is the first:
 * it is what every "Indian test card" on QA actually returned, and it was shown to the buyer
 * as "Payment was cancelled".
 */
describe('razorpayFailureReason', () => {
  it.each([
    [
      'international_transaction_not_allowed',
      'BAD_REQUEST_ERROR',
      'INTERNATIONAL_CARD_NOT_ACCEPTED',
    ],
    ['insufficient_funds', 'BAD_REQUEST_ERROR', 'INSUFFICIENT_FUNDS'],
    ['payment_cancelled', 'BAD_REQUEST_ERROR', 'CANCELLED'],
    ['payment_timed_out', 'BAD_REQUEST_ERROR', 'TIMED_OUT'],
    ['authentication_failed', 'BAD_REQUEST_ERROR', 'AUTHENTICATION_FAILED'],
    ['incorrect_otp', 'BAD_REQUEST_ERROR', 'AUTHENTICATION_FAILED'],
    ['card_declined', 'BAD_REQUEST_ERROR', 'CARD_DECLINED'],
    ['payment_risk_check_failed', 'BAD_REQUEST_ERROR', 'CARD_DECLINED'],
    ['bank_technical_error', 'GATEWAY_ERROR', 'BANK_UNAVAILABLE'],
    ['', 'SERVER_ERROR', 'BANK_UNAVAILABLE'],
    ['payment_method_not_enabled', 'BAD_REQUEST_ERROR', 'METHOD_NOT_AVAILABLE'],
  ])('%s (%s) → %s', (reason, code, expected) => {
    expect(razorpayFailureReason({ reason, code })).toBe(expected);
  });

  it('says UNKNOWN rather than guessing at a cause it does not recognise', () => {
    expect(razorpayFailureReason({ reason: 'something_new', code: 'BAD_REQUEST_ERROR' })).toBe(
      PaymentFailureReason.UNKNOWN,
    );
    expect(razorpayFailureReason(undefined)).toBe(PaymentFailureReason.UNKNOWN);
    expect(razorpayFailureReason({})).toBe(PaymentFailureReason.UNKNOWN);
  });

  it('treats "international ... not allowed" as international, not as a disabled method', () => {
    // Order matters: the generic "not allowed" rule would otherwise claim it.
    expect(razorpayFailureReason({ reason: 'international_transaction_not_allowed' })).toBe(
      PaymentFailureReason.INTERNATIONAL_CARD_NOT_ACCEPTED,
    );
  });

  it('recognises only its own codes as reasons', () => {
    expect(isPaymentFailureReason('CARD_DECLINED')).toBe(true);
    expect(isPaymentFailureReason('card_declined')).toBe(false);
    expect(isPaymentFailureReason('toString')).toBe(false);
    expect(isPaymentFailureReason(undefined)).toBe(false);
  });
});
