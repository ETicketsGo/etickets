import type { DomainEvent } from './domain-event';

/**
 * Reacts to a domain event. Handlers must be designed for AT-LEAST-ONCE delivery:
 * the same event may be handled more than once (redelivery, future durable
 * transport), so a handler that performs an external side effect MUST deduplicate by
 * `eventId + handlerName` (see the idempotency seam and ADR-038).
 *
 * A handler must never assume it is the only subscriber, and must not throw to
 * signal "not interested" — the bus isolates failures per handler.
 */
export interface DomainEventHandler<TEvent extends DomainEvent = DomainEvent> {
  /**
   * Stable identity for observability + idempotency keys. Defaults to the class name
   * when omitted, but an explicit, stable value is recommended.
   */
  readonly handlerName?: string;

  /**
   * The event versions this handler understands. Omit to accept all versions
   * (backward compatible). When set, an event whose version is not listed is skipped
   * with a visible warning + metric — it is never silently dropped. See ADR-038.
   */
  readonly supportedVersions?: readonly number[];

  handle(event: TEvent): Promise<void>;
}

/** The stable identity used in logs, metrics and idempotency keys. */
export function handlerIdentity(handler: DomainEventHandler): string {
  return handler.handlerName ?? handler.constructor?.name ?? 'anonymous';
}
