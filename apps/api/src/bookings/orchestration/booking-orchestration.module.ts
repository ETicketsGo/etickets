import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings.module';
import { BookingsController, GuestBookingsController } from '../bookings.controller';
import { BookingOrchestrationHealthController } from './booking-orchestration-health.controller';
import { PaymentsModule } from '../../payments/payments.module';
import { InventorySourcingModule } from '../../inventory/sourcing/inventory-sourcing.module';
import { InventoryLockingModule } from '../../inventory/locking/inventory-locking.module';
import { BookingProvidersModule } from '../providers/booking-providers.module';
import { BookingWorkflowRepository } from './booking-workflow.repository';
import { LocalBookingOrchestrator } from './local-booking-orchestrator.service';
import { BookingExecutionRouter } from './booking-execution-router.service';
import { ProviderAuthoritativeStrategy } from './provider-authoritative.strategy';
import { AllocatedInventoryStrategy } from './allocated-inventory.strategy';
import { AnonymousSessionService, BookingOwnerResolver } from './booking-owner';
import { BOOKING_ORCHESTRATOR } from './booking-orchestrator.contract';

/**
 * The concrete booking orchestrator + the single execution router + the booking HTTP
 * controllers (ADR-042, P5.1/P5.2A). Composes existing seams — resolver, lock service,
 * BookingsService, PaymentsService, workflow repository, outbox — for LOCAL_AUTHORITATIVE
 * inventory, and hosts the controllers so they route through ONE mode-decision point.
 * Registered at the app level; it imports BookingsModule + PaymentsModule (one direction —
 * those modules do NOT import this one, so there is no cycle). Active mode is opt-in
 * (BOOKING_ORCHESTRATOR_ENABLED + MODE=active, off by default); disabled/shadow leave the
 * legacy path authoritative.
 */
@Module({
  imports: [
    BookingsModule,
    PaymentsModule,
    InventorySourcingModule,
    InventoryLockingModule,
    BookingProvidersModule,
  ],
  controllers: [BookingsController, GuestBookingsController, BookingOrchestrationHealthController],
  providers: [
    BookingWorkflowRepository,
    LocalBookingOrchestrator,
    BookingExecutionRouter,
    ProviderAuthoritativeStrategy,
    AllocatedInventoryStrategy,
    BookingOwnerResolver,
    AnonymousSessionService,
    { provide: BOOKING_ORCHESTRATOR, useExisting: LocalBookingOrchestrator },
  ],
  exports: [
    BOOKING_ORCHESTRATOR,
    LocalBookingOrchestrator,
    BookingExecutionRouter,
    BookingWorkflowRepository,
    BookingOwnerResolver,
    AnonymousSessionService,
  ],
})
export class BookingOrchestrationModule {}
