import { capabilitySupports, PaymentMethod } from './payment-capabilities';
import type { PaymentProviderCapabilities } from './payment-capabilities';
import { PaymentErrorCode, PaymentProviderError } from './payment-errors';

const stripeLike: PaymentProviderCapabilities = {
  countries: ['US', 'CA', 'GB'],
  currencies: ['USD', 'GBP'],
  paymentMethods: [PaymentMethod.CARD],
  supportsPartialRefunds: true,
  supportsMultiplePartialRefunds: true,
  supportsAuthorizeCapture: true,
  supportsVoid: false,
  supportsIdempotentVoid: false,
  supportsPaymentStatusQuery: false,
  supportsFullRefund: false,
  supportsIdempotentRefund: false,
  supportsRefundStatusQuery: false,
  refundMayBeAsynchronous: false,
  supportsConnectedAccounts: true,
  supportsApplePay: true,
  supportsGooglePay: true,
  supportsUPI: false,
  supportsNetBanking: false,
  supportsWallets: true,
};

const dummyLike: PaymentProviderCapabilities = {
  ...stripeLike,
  countries: ['*'],
  currencies: ['*'],
};

describe('capabilitySupports', () => {
  it('matches a served (country, currency) pair, case-insensitively', () => {
    expect(capabilitySupports(stripeLike, 'US', 'USD')).toBe(true);
    expect(capabilitySupports(stripeLike, 'gb', 'gbp')).toBe(true);
  });
  it('rejects an unsupported country or currency', () => {
    expect(capabilitySupports(stripeLike, 'IN', 'USD')).toBe(false); // country not served
    expect(capabilitySupports(stripeLike, 'US', 'INR')).toBe(false); // currency not served
  });
  it('wildcard capabilities serve anything (dummy)', () => {
    expect(capabilitySupports(dummyLike, 'IN', 'INR')).toBe(true);
    expect(capabilitySupports(dummyLike, 'ZZ', 'XYZ')).toBe(true);
  });
});

describe('PaymentProviderError', () => {
  it('marks transient errors retryable (failover-safe)', () => {
    expect(
      new PaymentProviderError(PaymentErrorCode.PROVIDER_UNAVAILABLE, 'x', 'stripe').retryable,
    ).toBe(true);
    expect(
      new PaymentProviderError(PaymentErrorCode.PROVIDER_TIMEOUT, 'x', 'stripe').retryable,
    ).toBe(true);
  });
  it('marks terminal errors non-retryable (no failover)', () => {
    expect(
      new PaymentProviderError(PaymentErrorCode.AUTHENTICATION_FAILED, 'x', 'stripe').retryable,
    ).toBe(false);
    expect(new PaymentProviderError(PaymentErrorCode.CARD_DECLINED, 'x', 'stripe').retryable).toBe(
      false,
    );
    expect(
      new PaymentProviderError(PaymentErrorCode.INVALID_REQUEST, 'x', 'stripe').retryable,
    ).toBe(false);
  });
  it('carries the provider + normalized code', () => {
    const e = new PaymentProviderError(PaymentErrorCode.CARD_DECLINED, 'declined', 'razorpay');
    expect(e.provider).toBe('razorpay');
    expect(e.code).toBe(PaymentErrorCode.CARD_DECLINED);
    expect(e).toBeInstanceOf(Error);
  });
});
