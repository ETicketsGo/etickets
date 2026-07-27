// Public surface of the domain event layer (ADR-038). Domain modules import from
// here — never from a transport. Keep exports transport-neutral.
export * from './domain-event';
export * from './domain-event-handler';
export * from './domain-event-bus';
export * from './domain-event.errors';
export * from './domain-event.factory';
export * from './idempotency';
export { DomainEventCollector, TransactionalEventPublisher } from './transactional-event-publisher';
export { InProcessDomainEventBus } from './in-process-domain-event-bus';
export { DomainEventsModule } from './domain-events.module';

// Catalogue
export * from './catalogue/event-types';
export * from './catalogue/booking-events';
export * from './catalogue/inventory-events';
export * from './catalogue/refund-events';
export * from './catalogue/ticket-events';
