import { ConfigService } from '@nestjs/config';
import type { MockPaymentProvider } from './mock-payment.provider';
import { selectPaymentProvider } from './payment-provider.factory';
import { RazorpayPaymentProvider } from './razorpay-payment.provider';
import { StripePaymentProvider } from './stripe-payment.provider';

// Mock both SDKs so constructing a real provider never hits the network.
jest.mock('stripe', () => jest.fn().mockImplementation(() => ({})));
jest.mock('razorpay', () => jest.fn().mockImplementation(() => ({})));

// Sentinel standing in for the pre-built MockPaymentProvider instance.
const mockProvider = { name: 'mock' } as unknown as MockPaymentProvider;

function configFor(name?: string): ConfigService {
  const values: Record<string, string | undefined> = {
    PAYMENT_PROVIDER_NAME: name,
    RAZORPAY_KEY_ID: 'rzp_test_key',
    RAZORPAY_KEY_SECRET: 'rzp_test_secret',
    RAZORPAY_WEBHOOK_SECRET: 'rzp_webhook',
    STRIPE_SECRET_KEY: 'sk_test_1',
    STRIPE_WEBHOOK_SECRET: 'whsec_1',
    STRIPE_SUCCESS_URL: 'http://localhost/ok',
    STRIPE_CANCEL_URL: 'http://localhost/cancel',
  };
  return {
    get: (k: string) => values[k],
    getOrThrow: (k: string) => values[k],
  } as unknown as ConfigService;
}

describe('selectPaymentProvider', () => {
  it('defaults to the mock provider when PAYMENT_PROVIDER_NAME is unset', () => {
    expect(selectPaymentProvider(configFor(undefined), mockProvider)).toBe(mockProvider);
  });

  it('returns the mock provider when PAYMENT_PROVIDER_NAME=mock', () => {
    expect(selectPaymentProvider(configFor('mock'), mockProvider)).toBe(mockProvider);
  });

  it('constructs the Razorpay provider when PAYMENT_PROVIDER_NAME=razorpay', () => {
    const provider = selectPaymentProvider(configFor('razorpay'), mockProvider);
    expect(provider).toBeInstanceOf(RazorpayPaymentProvider);
    expect(provider.name).toBe('razorpay');
  });

  it('constructs the Stripe provider when PAYMENT_PROVIDER_NAME=stripe', () => {
    const provider = selectPaymentProvider(configFor('stripe'), mockProvider);
    expect(provider).toBeInstanceOf(StripePaymentProvider);
    expect(provider.name).toBe('stripe');
  });

  it('fails fast with a clear error when the selected provider is missing keys', () => {
    const emptyConfig = {
      get: () => undefined,
      getOrThrow: () => undefined,
    } as unknown as ConfigService;
    expect(() =>
      selectPaymentProvider(
        {
          ...emptyConfig,
          get: (k: string) => (k === 'PAYMENT_PROVIDER_NAME' ? 'stripe' : undefined),
        } as unknown as ConfigService,
        mockProvider,
      ),
    ).toThrow(/STRIPE_SECRET_KEY/);
  });
});
