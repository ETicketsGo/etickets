import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings.module';
import { PaymentsModule } from '../../payments/payments.module';
import { InventorySourcingModule } from '../../inventory/sourcing/inventory-sourcing.module';
import { InventoryLockingModule } from '../../inventory/locking/inventory-locking.module';
import { BookingWorkflowRepository } from './booking-workflow.repository';
import { LocalBookingOrchestrator } from './local-booking-orchestrator.service';
import { BOOKING_ORCHESTRATOR } from './booking-orchestrator.contract';

/**
 * The concrete booking orchestrator (ADR-042, P5.1). Composes existing seams — resolver,
 * lock service, BookingsService, PaymentsService, workflow repository, outbox — for
 * LOCAL_AUTHORITATIVE inventory. Registered at the app level; it imports BookingsModule +
 * PaymentsModule (one direction — those modules do NOT import this one, so there is no
 * cycle). Active mode is opt-in (BOOKING_ORCHESTRATOR_ENABLED + MODE=active, off by
 * default); disabled/shadow leave the legacy path authoritative.
 */
@Module({
  imports: [BookingsModule, PaymentsModule, InventorySourcingModule, InventoryLockingModule],
  providers: [
    BookingWorkflowRepository,
    LocalBookingOrchestrator,
    { provide: BOOKING_ORCHESTRATOR, useExisting: LocalBookingOrchestrator },
  ],
  exports: [BOOKING_ORCHESTRATOR, LocalBookingOrchestrator, BookingWorkflowRepository],
})
export class BookingOrchestrationModule {}
