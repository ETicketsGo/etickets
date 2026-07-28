import { randomUUID } from 'node:crypto';
import type { DomainEvent, NewDomainEvent } from './domain-event';
import { InvalidDomainEventError } from './domain-event.errors';

/**
 * Creates and validates {@link DomainEvent}s. Stamps a unique `eventId` and
 * `occurredAt`, defaults `eventVersion` to 1, and enforces the envelope invariants so
 * a malformed fact can never enter the bus. Pure + static — no DI needed. See ADR-038.
 */
export const DomainEventFactory = {
  create<TPayload>(input: NewDomainEvent<TPayload>): DomainEvent<TPayload> {
    const event: DomainEvent<TPayload> = {
      eventId: input.eventId ?? randomUUID(),
      eventType: input.eventType,
      eventVersion: input.eventVersion ?? 1,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      occurredAt: input.occurredAt ?? new Date(),
      correlationId: input.correlationId,
      causationId: input.causationId,
      actorId: input.actorId,
      tenantId: input.tenantId,
      payload: input.payload,
      metadata: input.metadata,
    };
    assertValidDomainEvent(event);
    return event;
  },

  /**
   * Derive a child event that continues a workflow: the child preserves the parent's
   * `correlationId` and records the parent's `eventId` as its `causationId`. Actor and
   * tenant carry over unless overridden. See ADR-038 (correlation & causation).
   */
  createCausedBy<TPayload>(
    parent: DomainEvent,
    input: NewDomainEvent<TPayload>,
  ): DomainEvent<TPayload> {
    return DomainEventFactory.create({
      correlationId: parent.correlationId ?? parent.eventId,
      causationId: parent.eventId,
      actorId: parent.actorId,
      tenantId: parent.tenantId,
      ...input,
    });
  },
};

/** Throws {@link InvalidDomainEventError} if the envelope violates its invariants. */
export function assertValidDomainEvent(event: DomainEvent): void {
  const problems: string[] = [];
  if (!event.eventId) problems.push('eventId is required');
  if (!event.eventType || !event.eventType.trim()) problems.push('eventType is required');
  if (!Number.isInteger(event.eventVersion) || event.eventVersion < 1) {
    problems.push('eventVersion must be a positive integer');
  }
  if (!event.aggregateType || !event.aggregateType.trim()) {
    problems.push('aggregateType is required');
  }
  if (!event.aggregateId || !event.aggregateId.trim()) problems.push('aggregateId is required');
  if (!(event.occurredAt instanceof Date) || Number.isNaN(event.occurredAt.getTime())) {
    problems.push('occurredAt must be a valid Date');
  }
  if (event.payload === undefined || event.payload === null) {
    problems.push('payload is required');
  }
  if (problems.length > 0) {
    throw new InvalidDomainEventError(`Invalid domain event: ${problems.join('; ')}`, {
      eventType: event.eventType,
      problems,
    });
  }
}
