// Public surface of the domain event layer (ADR-038). Domain modules import from
// here — never from a transport. Keep exports transport-neutral.
export * from './domain-event';
export * from './domain-event-handler';
export * from './domain-event-bus';
export * from './domain-event.errors';
export * from './domain-event.factory';
export * from './idempotency';
export {
  DomainEventCollector,
  TransactionalEventPublisher,
  type DomainEventDeliveryMode,
} from './transactional-event-publisher';
export { InProcessDomainEventBus } from './in-process-domain-event-bus';
export { DomainEventsModule } from './domain-events.module';

// Transactional outbox (ADR-041)
export { OutboxModule } from './outbox/outbox.module';
export { OutboxRecorder } from './outbox/outbox-recorder';
export { OutboxDispatcher } from './outbox/outbox-dispatcher.service';
export { OutboxHealthService } from './outbox/outbox-health.service';
export { OutboxRetentionService } from './outbox/outbox-retention.service';
export { ProcessedEventStore } from './outbox/processed-event.store';
export * from './outbox/outbox.errors';

// Catalogue
export * from './catalogue/event-types';
export * from './catalogue/booking-events';
export * from './catalogue/inventory-events';
export * from './catalogue/refund-events';
export * from './catalogue/ticket-events';
export * from './catalogue/sync-events';
