import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings.module';
import { BookingsController, GuestBookingsController } from '../bookings.controller';
import { BookingOrchestrationHealthController } from './booking-orchestration-health.controller';
import { PaymentsModule } from '../../payments/payments.module';
import { InventorySourcingModule } from '../../inventory/sourcing/inventory-sourcing.module';
import { InventoryLockingModule } from '../../inventory/locking/inventory-locking.module';
import { BookingProvidersModule } from '../providers/booking-providers.module';
import { TicketsModule } from '../../tickets/tickets.module';
import { ReceiptsModule } from '../../receipts/receipts.module';
import { RefundsModule } from '../../refunds/refunds.module';
import { GuestBookingService } from '../guest-booking.service';
import { GuestSessionVerifier } from '../guest-session';
import { BookingWorkflowRepository } from './booking-workflow.repository';
import { LocalBookingOrchestrator } from './local-booking-orchestrator.service';
import { BookingExecutionRouter } from './booking-execution-router.service';
import { ProviderAuthoritativeStrategy } from './provider-authoritative.strategy';
import { AllocatedInventoryStrategy } from './allocated-inventory.strategy';
import { AllocationAccountingService } from './allocation-accounting.service';
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
    // The guest read routes hand out QR codes, and TicketsService is the only place a QR
    // payload is signed. TicketsModule imports nothing, so there is no cycle to create.
    TicketsModule,
    /*
      Guest self-service reuses the account services rather than reimplementing them: the frozen
      receipt document and its one renderer, and the one body that decides whether a refund may
      happen. Both edges run one way — neither module knows anything about booking orchestration
      — so there is no cycle, and PaymentsModule (which RefundsModule also imports) is already
      here.
    */
    ReceiptsModule,
    RefundsModule,
  ],
  controllers: [BookingsController, GuestBookingsController, BookingOrchestrationHealthController],
  providers: [
    BookingWorkflowRepository,
    LocalBookingOrchestrator,
    BookingExecutionRouter,
    ProviderAuthoritativeStrategy,
    AllocatedInventoryStrategy,
    AllocationAccountingService,
    BookingOwnerResolver,
    AnonymousSessionService,
    // Shared by the guest read/claim routes and the guest PAYMENT route, so "is this the browser
    // that created the booking?" has exactly one implementation.
    GuestSessionVerifier,
    GuestBookingService,
    { provide: BOOKING_ORCHESTRATOR, useExisting: LocalBookingOrchestrator },
  ],
  exports: [
    BOOKING_ORCHESTRATOR,
    LocalBookingOrchestrator,
    BookingExecutionRouter,
    BookingWorkflowRepository,
    BookingOwnerResolver,
    AnonymousSessionService,
    GuestSessionVerifier,
    GuestBookingService,
  ],
})
export class BookingOrchestrationModule {}
