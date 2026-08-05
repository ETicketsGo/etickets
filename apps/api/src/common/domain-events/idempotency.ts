import type { DomainEvent } from './domain-event';

/**
 * Idempotency seam for at-least-once delivery (ADR-038). A handler that performs an
 * external, non-idempotent side effect should guard it with a store keyed by
 * {@link idempotencyKey} so a redelivered event is a no-op on the second pass.
 *
 * This is intentionally a small seam, NOT an infrastructure layer: the durable,
 * cross-process implementation (a table + the outbox) is deferred to P2.1. The
 * in-memory implementation below is for single-process handlers and tests.
 */
export interface ProcessedEventStore {
  has(key: string): Promise<boolean>;
  markProcessed(key: string): Promise<void>;
}

/** Dedup key for a handler processing an event: stable across redeliveries. */
export function idempotencyKey(event: DomainEvent, handlerName: string): string {
  return `${event.eventId}:${handlerName}`;
}

/** Process-local store — fine for idempotent-within-a-process handlers and tests. */
export class InMemoryProcessedEventStore implements ProcessedEventStore {
  private readonly seen = new Set<string>();

  async has(key: string): Promise<boolean> {
    return this.seen.has(key);
  }

  async markProcessed(key: string): Promise<void> {
    this.seen.add(key);
  }
}
