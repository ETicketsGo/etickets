import { ConfigService } from '@nestjs/config';
import type { MockPaymentProvider } from './mock-payment.provider';
import type { PaymentProvider } from './payment-provider.interface';
import { RazorpayPaymentProvider } from './razorpay-payment.provider';
import { StripePaymentProvider } from './stripe-payment.provider';

export type PaymentProviderName = 'mock' | 'razorpay' | 'stripe';

/**
 * Resolves the active PaymentProvider from PAYMENT_PROVIDER_NAME (default 'mock').
 *
 * Only the selected provider is constructed here, so missing Stripe/Razorpay keys
 * never break boot in dev/test/mock. The pre-built MockPaymentProvider instance is
 * reused (PaymentsService also injects it directly for its dev mock-pay path).
 */
export function selectPaymentProvider(
  config: ConfigService,
  mock: MockPaymentProvider,
): PaymentProvider {
  const name = config.get<PaymentProviderName>('PAYMENT_PROVIDER_NAME') ?? 'mock';
  switch (name) {
    case 'stripe':
      return new StripePaymentProvider(config);
    case 'razorpay':
      return new RazorpayPaymentProvider(config);
    case 'mock':
      return mock;
    default:
      return mock;
  }
}
