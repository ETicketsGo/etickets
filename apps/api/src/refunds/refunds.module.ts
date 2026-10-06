import { Module, type OnModuleInit } from '@nestjs/common';
import {
  AdminRefundsController,
  OrganizationRefundsController,
  RefundsController,
} from './refunds.controller';
import { RefundsService } from './refunds.service';
import { CancellationRefundsService } from './cancellation-refunds.service';
import { CancellationRefundsHandler } from './cancellation-refunds.handler';
import { PaymentsModule } from '../payments/payments.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ReceiptsModule } from '../receipts/receipts.module';
import { InProcessDomainEventBus } from '../common/domain-events/in-process-domain-event-bus';
import { DomainEventType } from '../common/domain-events/catalogue/event-types';

@Module({
  imports: [PaymentsModule, InventoryModule, ReceiptsModule],
  controllers: [RefundsController, OrganizationRefundsController, AdminRefundsController],
  providers: [RefundsService, CancellationRefundsService, CancellationRefundsHandler],
  // Exported for the guest access-link entry (`requestAsGuest`), which lives on
  // GuestBookingService so that guest authorisation stays in one place — while the refund RULES
  // stay in exactly one place too, here. The dependency runs one way: booking orchestration
  // imports refunds, and refunds knows nothing about bookings.
  exports: [RefundsService, CancellationRefundsService, CancellationRefundsHandler],
})
export class RefundsModule implements OnModuleInit {
  constructor(
    private readonly bus: InProcessDomainEventBus,
    private readonly cancellationRefunds: CancellationRefundsHandler,
  ) {}

  /**
   * Refunds subscribes ITSELF to the cancellation event.
   *
   * ── WHY NOT ALONGSIDE THE NOTIFICATION HANDLER ─────────────────────────────────────
   * `DomainEventsModule` subscribes the cancellation NOTIFICATION handler, and the obvious
   * move was to add this one beside it. That would have failed silently.
   *
   * It works there because `NotificationsModule` is `@Global()`, so its exported handler is
   * injectable anywhere. `RefundsModule` is not global and should not become global to make a
   * subscription convenient. The handler is declared `@Optional()` there, so a handler that
   * could not be resolved would have been `undefined` - and the `if` guarding it would simply
   * not have subscribed. No error, no log, no refunds, for the exact failure this whole change
   * exists to remove.
   *
   * So the dependency runs the other way. `DomainEventsModule` is `@Global()` precisely so a
   * domain module can reach the bus, and a module knowing which of its own handlers to attach
   * is better placed than a platform module knowing about refunds.
   */
  onModuleInit(): void {
    this.bus.subscribe(DomainEventType.SessionCancelled, this.cancellationRefunds);
  }
}
