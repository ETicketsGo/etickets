import { Module } from '@nestjs/common';
import { MockExternalBookingProvider } from './mock-external-booking-provider';
import { QubeMockExternalBookingProvider } from './qube-mock-external-booking.provider';
import { InventorySourcingModule } from '../../inventory/sourcing/inventory-sourcing.module';
import { ExternalBookingProviderRegistry } from './external-booking-provider.registry';

/**
 * External booking provider seam (ADR-042 §6/§8, P5.2B). Provides the dev/test mock provider
 * and the registry that resolves providers by code. Constructed always; the registry only
 * REGISTERS the mock when its flag is on (and startup validation forbids the flag in
 * production), so this module is a safe no-op by default. Kept separate from inventory
 * sourcing (P1), inventory sync (P4), and payment providers.
 */
@Module({
  imports: [InventorySourcingModule],
  providers: [
    MockExternalBookingProvider,
    QubeMockExternalBookingProvider,
    ExternalBookingProviderRegistry,
  ],
  exports: [
    ExternalBookingProviderRegistry,
    MockExternalBookingProvider,
    QubeMockExternalBookingProvider,
  ],
})
export class BookingProvidersModule {}
