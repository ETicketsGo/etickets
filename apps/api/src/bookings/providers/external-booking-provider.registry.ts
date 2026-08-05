import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MockExternalBookingProvider } from './mock-external-booking-provider';
import { ExternalBookingException, ExternalBookingFailure } from './external-booking.errors';
import type {
  ExternalBookingProvider,
  ExternalBookingProviderCapabilities,
} from './external-booking-provider.interface';

/**
 * The set of constructed external booking providers (ADR-042 §8, P5.2B). Today only the
 * dev/test mock is registerable, and ONLY when `BOOKING_PROVIDER_CONFIRMATION_MOCK_ENABLED`
 * is on (startup validation forbids it in production). Resolution is by provider code; a
 * missing provider is a typed, safe failure — never a fabricated success.
 */
@Injectable()
export class ExternalBookingProviderRegistry {
  private readonly providers = new Map<string, ExternalBookingProvider>();

  constructor(config: ConfigService, mock: MockExternalBookingProvider) {
    if (config.get<boolean>('BOOKING_PROVIDER_CONFIRMATION_MOCK_ENABLED') === true) {
      this.providers.set(mock.providerCode, mock);
    }
  }

  get(code: string): ExternalBookingProvider | undefined {
    return this.providers.get(code);
  }

  require(code: string): ExternalBookingProvider {
    const p = this.providers.get(code);
    if (!p)
      throw new ExternalBookingException(ExternalBookingFailure.PROVIDER_MAPPING_MISSING, { code });
    return p;
  }

  list(): string[] {
    return [...this.providers.keys()];
  }

  async health(): Promise<Record<string, boolean>> {
    const out: Record<string, boolean> = {};
    for (const [code, p] of this.providers) {
      out[code] = await p
        .health()
        .then((h) => h.healthy)
        .catch(() => false);
    }
    return out;
  }
}

/** The provider-authoritative payment/confirmation sequence selected from capabilities. */
export type ProviderBookingSequence =
  | 'RESERVE_PAY_CONFIRM' // reserve → pay → confirm reservation (default safe strategy)
  | 'PAY_RESERVE_CONFIRM'; // payment required before reservation

/**
 * Choose the safest supported provider-authoritative sequence for a provider's capabilities
 * (ADR-042 §7/§11). Reserve→Pay→Confirm is preferred; it is only valid when the provider can
 * hold a temporary reservation and confirm it. Unsupported capability combinations fail
 * BEFORE any payment is collected.
 */
export function selectProviderSequence(
  caps: ExternalBookingProviderCapabilities,
): ProviderBookingSequence {
  if (!caps.supportsConfirm) {
    throw new ExternalBookingException(ExternalBookingFailure.PROVIDER_CAPABILITY_UNSUPPORTED, {
      reason: 'no_confirm',
    });
  }
  if (caps.requiresPaymentBeforeReservation) {
    // Payment-first requires an explicit compensation strategy (P5.3) — unsupported here.
    throw new ExternalBookingException(ExternalBookingFailure.PROVIDER_CAPABILITY_UNSUPPORTED, {
      reason: 'payment_before_reservation_unsupported',
    });
  }
  if (!caps.supportsTemporaryReservation) {
    throw new ExternalBookingException(ExternalBookingFailure.PROVIDER_CAPABILITY_UNSUPPORTED, {
      reason: 'no_temporary_reservation',
    });
  }
  return 'RESERVE_PAY_CONFIRM';
}
