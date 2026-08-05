import type { DomainEvent } from './domain-event';
import type { DomainEventHandler } from './domain-event-handler';

/** Options a subscriber may pass when registering. */
export interface SubscribeOptions {
  /**
   * Event versions this subscription accepts. Omit to accept all. Takes precedence
   * over the handler's own `supportedVersions` when both are present.
   */
  versions?: readonly number[];
}

/**
 * The provider-neutral domain event bus (ADR-038). Domain modules depend ONLY on this
 * interface — never on BullMQ, Kafka, SNS, or NestJS EventEmitter. The current
 * implementation is synchronous and in-process; a future durable transport implements
 * the same interface behind the same DI token, so producers/consumers never change.
 *
 * Publication semantics (in-process implementation):
 * - `publish` resolves once every matching handler has run (sequentially, in
 *   registration order). One handler failing does NOT prevent the others from running
 *   and does NOT reject the publish — failures are logged + counted (observable), so a
 *   post-commit publish never "un-commits" the transaction.
 * - Validation failures (malformed event) DO reject, because they indicate a producer
 *   bug, not a handler fault.
 */
export interface DomainEventBus {
  publish(event: DomainEvent): Promise<void>;
  publishMany(events: DomainEvent[]): Promise<void>;
  subscribe<TEvent extends DomainEvent>(
    eventType: string,
    handler: DomainEventHandler<TEvent>,
    options?: SubscribeOptions,
  ): void;
}

/** DI token so consumers inject the abstraction, not a concrete class. */
export const DOMAIN_EVENT_BUS = Symbol('DOMAIN_EVENT_BUS');
