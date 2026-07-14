import { Inject, Injectable } from '@nestjs/common';
import { MockPaymentProvider } from '../provider/mock-payment.provider';
import { PAYMENT_PROVIDER, type PaymentProvider } from '../provider/payment-provider.interface';

/**
 * Resolves a concrete PaymentProvider adapter by the provider name used in runtime
 * configuration (ADR-021). Only providers that are actually constructed in this
 * process are registered: the mock (always) and the env-selected active provider.
 *
 * Real Stripe/Razorpay/PayPal/Square adapters are constructed only when their
 * credentials are present (see payments.module + factory), so a config route naming
 * a provider whose credentials are not wired here resolves to `undefined`; the
 * orchestrator then falls back to the default provider (dev/local) or fails closed
 * (staging/production). Wiring every provider from secret-manager references is a
 * follow-on once a secret manager is available.
 *
 * The config domain calls the simulated provider 'dummy'; the adapter is named
 * 'mock'. They are aliases here.
 */
@Injectable()
export class PaymentProviderRegistry {
  private readonly byName = new Map<string, PaymentProvider>();

  constructor(@Inject(PAYMENT_PROVIDER) active: PaymentProvider, mock: MockPaymentProvider) {
    this.register(mock);
    this.register(active);
    // 'dummy' (config vocabulary) → the mock adapter.
    this.byName.set('dummy', mock);
  }

  private register(provider: PaymentProvider): void {
    this.byName.set(provider.name.toLowerCase(), provider);
  }

  get(name: string): PaymentProvider | undefined {
    return this.byName.get(name.toLowerCase());
  }

  has(name: string): boolean {
    return this.byName.has(name.toLowerCase());
  }

  /** Distinct constructed adapters (deduped — 'dummy'/'mock' resolve to one). */
  list(): PaymentProvider[] {
    return Array.from(new Set(this.byName.values()));
  }
}
