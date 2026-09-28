import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MockPaymentProvider } from './mock-payment.provider';
import type { PaymentProvider } from './payment-provider.interface';
import { PayPalPaymentProvider } from './paypal-payment.provider';
import { RazorpayPaymentProvider } from './razorpay-payment.provider';
import { SquarePaymentProvider } from './square-payment.provider';
import { UnavailablePaymentProvider } from './unavailable-payment.provider';
import { StripePaymentProvider } from './stripe-payment.provider';

export type PaymentProviderName = 'mock' | 'razorpay' | 'stripe' | 'paypal' | 'square';

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

  /*
    The declared "not activated yet" state.

    A gateway will not issue live keys until it can open a live product URL, and this platform
    refuses to serve a production storefront on a simulated gateway - so there is a real gap
    between being open as a catalogue and being able to charge. Without this the gap has nowhere
    to live: a real provider name with no credentials does not boot, because the adapters demand
    their keys in their constructors, and that is the RIGHT default for a mistyped key.

    So it is declared, never inferred. `PAYMENTS_ACTIVATION_PENDING=true` is an operator saying
    "we know, we are waiting on the gateway". Configuration refuses the flag when credentials are
    actually present, so it can never be used to quietly switch off a working gateway.
  */
  if (config.get<string>('PAYMENTS_ACTIVATION_PENDING') === 'true' && name !== 'mock') {
    new Logger('PaymentProvider').warn(
      `Payments are NOT ACTIVATED (PAYMENTS_ACTIVATION_PENDING=true). ${name} is configured but ` +
        'has no credentials, so every payment will be refused. The storefront tells buyers so.',
    );
    return new UnavailablePaymentProvider(name);
  }

  switch (name) {
    case 'stripe':
      return new StripePaymentProvider(config);
    case 'razorpay':
      return new RazorpayPaymentProvider(config);
    case 'paypal':
      return new PayPalPaymentProvider(config);
    case 'square':
      return new SquarePaymentProvider(config);
    case 'mock':
      return mock;
    default:
      return mock;
  }
}
