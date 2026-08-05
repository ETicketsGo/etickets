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
    return { name, provider: this.get(name) };
  }

  private construct(name: string): PaymentProvider {
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
