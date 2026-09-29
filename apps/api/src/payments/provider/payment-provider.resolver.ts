import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  routeProviderForBooking,
  isCountryConsistent,
  type MarketplaceProvider,
  type ProviderRouteContext,
} from '@eticketsgo/shared-types';
import { AppException, ErrorCodes } from '../../common/errors';
import { PaymentProviderRegistry } from '../orchestration/provider-registry';
import { MockPaymentProvider } from './mock-payment.provider';
import { RazorpayPaymentProvider } from './razorpay-payment.provider';
import { StripePaymentProvider } from './stripe-payment.provider';
import { PayPalPaymentProvider } from './paypal-payment.provider';
import { SquarePaymentProvider } from './square-payment.provider';
import { UnavailablePaymentProvider } from './unavailable-payment.provider';
import type { PaymentProvider } from './payment-provider.interface';

/**
 * Resolves a payment adapter by name, or by a booking's trusted country/currency.
 *
 * This is what lets US → Stripe and IN → Razorpay run SIMULTANEOUSLY: adapters are
 * constructed lazily from config on first use and cached in the registry, so boot never
 * needs every provider's keys, but any configured provider is reachable on demand.
 * Construction fails fast (the adapter constructor throws) when a selected provider's
 * server secrets are missing — surfacing a clear error rather than a silent fallback.
 */
@Injectable()
export class PaymentProviderResolver {
  constructor(
    private readonly config: ConfigService,
    private readonly registry: PaymentProviderRegistry,
    private readonly mock: MockPaymentProvider,
  ) {}

  /** Get (constructing + caching if needed) the adapter for a provider name. */
  get(name: string): PaymentProvider {
    const key = name.toLowerCase();
    const existing = this.registry.get(key);
    if (existing) return existing;
    const provider = this.construct(key);
    this.registry.add(provider);
    return provider;
  }

  /**
   * The adapter for a provider this deployment may simply not have keys for.
   *
   * ── WHY A MISSING KEY IS NOT AN ERROR HERE ─────────────────────────────────────────
   * A deployment can legitimately serve one currency and not another: with Stripe live and
   * Razorpay still in application, USD and CAD are payable and INR is not. The routing table
   * still sends an INR booking to Razorpay - correctly, because Stripe settling rupees for an
   * Indian seller is not the fallback anybody wants - and the adapter's constructor then throws
   * for want of `RAZORPAY_KEY_ID`.
   *
   * Thrown from here that surfaces as a 500 on the payment step: the buyer sees a broken
   * checkout, which is both alarming and untrue. It is the same fact the activation notice
   * already exists to state, so it is answered the same way - a provider that refuses every
   * operation, so the storefront says online payment is being activated and nothing is charged.
   *
   * Only a MISSING CREDENTIAL is treated this way. Any other construction failure is a real
   * fault and is left to throw.
   */
  private getOrUnavailable(name: string): PaymentProvider {
    try {
      return this.get(name);
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (/requires [A-Z0-9_]+ to be set/.test(message)) {
        return new UnavailablePaymentProvider(name);
      }
      throw err;
    }
  }

  /** Resolve the provider for a booking from trusted business data (never the client). */
  forBooking(ctx: ProviderRouteContext): { name: MarketplaceProvider; provider: PaymentProvider } {
    const name = routeProviderForBooking(ctx);
    if (!name) {
      throw new AppException(
        ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE,
        `No payment provider supports currency ${ctx.currency}.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!isCountryConsistent(name, ctx.country)) {
      throw new AppException(
        ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE,
        `Country ${ctx.country} is not supported for ${ctx.currency} (${name}).`,
        HttpStatus.BAD_REQUEST,
      );
    }
    // Not `get`: a currency whose provider this deployment has no keys for is refused
    // cleanly rather than crashing the payment step.
    return { name, provider: this.getOrUnavailable(name) };
  }

  private construct(name: string): PaymentProvider {
    /*
      The declared not-activated state, honoured HERE as well as in the boot factory.

      This is the path a booking actually takes - `selectPaymentProvider` builds the single
      configured adapter, while the orchestrator resolves per currency through this resolver. With
      only the factory changed, a paid booking still constructed the real adapter, which threw for
      want of credentials, and the orchestrator then failed over to the next provider in the chain.
      Both places have to agree or the state is a claim the money path does not honour.
    */
    if (this.config.get<string>('PAYMENTS_ACTIVATION_PENDING') === 'true' && name !== 'mock') {
      return new UnavailablePaymentProvider(name);
    }
    switch (name) {
      case 'stripe':
        return new StripePaymentProvider(this.config);
      case 'razorpay':
        return new RazorpayPaymentProvider(this.config);
      case 'paypal':
        return new PayPalPaymentProvider(this.config);
      case 'square':
        return new SquarePaymentProvider(this.config);
      case 'mock':
      case 'dummy':
        return this.mock;
      default:
        throw new AppException(
          ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE,
          `Unknown payment provider '${name}'.`,
          HttpStatus.BAD_REQUEST,
        );
    }
  }
}
