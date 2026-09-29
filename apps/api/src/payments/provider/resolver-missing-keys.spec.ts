import 'reflect-metadata';
import { PaymentProviderResolver } from './payment-provider.resolver';
import { PaymentProviderRegistry } from '../orchestration/provider-registry';
import { UnavailablePaymentProvider } from './unavailable-payment.provider';

/**
 * A deployment can serve one currency and not another.
 *
 * ── WHY THIS MATTERS THE DAY STRIPE GOES LIVE ──────────────────────────────────────
 * With Stripe configured and Razorpay still in application, USD and CAD are payable and INR is
 * not. The routing table still sends an INR booking to Razorpay, correctly - Stripe settling
 * rupees for an Indian seller is not a fallback anybody wants - and that adapter's constructor
 * then throws for want of `RAZORPAY_KEY_ID`.
 *
 * Thrown from the resolver, that reached the buyer as a 500 on the payment step: a checkout that
 * looks broken, over a fact about us. It is the same fact the activation notice exists to state,
 * so it is answered the same way and nothing is charged.
 */
describe('a routed provider this deployment has no keys for', () => {
  // Stripe demands its webhook secret at construction too - a gateway that can charge but
  // cannot verify the confirmation would be a customer charged with no ticket.
  const STRIPE_LIVE = { STRIPE_SECRET_KEY: 'sk_live_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' };

  const resolverWith = (env: Record<string, string>) => {
    const config = { get: (k: string) => env[k] } as never;
    const mock = { name: 'mock' } as never;
    // The registry wants the boot-selected adapter and the mock; neither is exercised here,
    // because every case below resolves per currency rather than through the active provider.
    const registry = new PaymentProviderRegistry(mock, mock);
    return new PaymentProviderResolver(config, registry, mock);
  };

  it('is refused cleanly rather than crashing the payment step', () => {
    // Stripe is live, Razorpay is not - the state PROD is in the day US payments open.
    const resolver = resolverWith(STRIPE_LIVE);
    const { name, provider } = resolver.forBooking({ currency: 'INR', country: 'India' });
    expect(name).toBe('razorpay');
    expect(provider).toBeInstanceOf(UnavailablePaymentProvider);
    // It still says WHICH gateway is being waited on.
    expect(provider.name).toBe('razorpay');
  });

  it('still builds the provider that does have its keys', () => {
    const resolver = resolverWith(STRIPE_LIVE);
    const { name, provider } = resolver.forBooking({ currency: 'USD', country: 'United States' });
    expect(name).toBe('stripe');
    expect(provider).not.toBeInstanceOf(UnavailablePaymentProvider);
  });

  it('routes Canada to Stripe, which is the gap this all started from', () => {
    const resolver = resolverWith(STRIPE_LIVE);
    const { name, provider } = resolver.forBooking({ currency: 'CAD', country: 'Canada' });
    expect(name).toBe('stripe');
    expect(provider).not.toBeInstanceOf(UnavailablePaymentProvider);
  });

  it('refuses a currency nobody settles', () => {
    const resolver = resolverWith(STRIPE_LIVE);
    expect(() => resolver.forBooking({ currency: 'JPY' })).toThrow(/No payment provider supports/);
  });
});
