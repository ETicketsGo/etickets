import { Global, Module, OnModuleInit } from '@nestjs/common';
import { DOMAIN_EVENT_BUS, type DomainEventBus } from './domain-event-bus';
import { InProcessDomainEventBus, domainEventBusProvider } from './in-process-domain-event-bus';
import { TransactionalEventPublisher } from './transactional-event-publisher';
import { BookingEventRecorder } from './handlers/booking-event.recorder';
import { DomainEventType } from './catalogue/event-types';
import { OutboxModule } from './outbox/outbox.module';

/**
 * The domain event bus platform module (ADR-038). @Global so any domain module can
 * inject `DOMAIN_EVENT_BUS` / `TransactionalEventPublisher` without importing this
 * module (mirrors MetricsModule) — a one-directional dependency that avoids cycles:
 * domain modules depend on the bus, never the reverse.
 *
 * Handler subscriptions are wired here in onModuleInit. The P2 proof slice registers
 * the BookingEventRecorder for `booking.confirmed`. When DOMAIN_EVENTS_ENABLED is off,
 * publish() is a no-op so registered handlers never run.
 */
@Global()
@Module({
  imports: [OutboxModule],
  providers: [
    InProcessDomainEventBus,
    domainEventBusProvider,
    TransactionalEventPublisher,
    BookingEventRecorder,
  ],
  exports: [DOMAIN_EVENT_BUS, TransactionalEventPublisher, InProcessDomainEventBus, OutboxModule],
})
export class DomainEventsModule implements OnModuleInit {
  constructor(
    private readonly bus: InProcessDomainEventBus,
    private readonly bookingRecorder: BookingEventRecorder,
  ) {}

  onModuleInit(): void {
    const bus: DomainEventBus = this.bus;
    bus.subscribe(DomainEventType.BookingConfirmed, this.bookingRecorder);
  }
}
