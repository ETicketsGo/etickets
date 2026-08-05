import type { DomainEvent } from '../domain-event';
import { DomainEventFactory } from '../domain-event.factory';
import { DomainEventType, DomainEventVersion, type EventTracing } from './event-types';

/**
 * Inventory sourcing/hold facts (complements ADR-037). Identifiers + counts only —
 * never seat holder PII. `provider` is the sourcing provider name (direct/manual/…).
 */

export interface InventoryLockedPayload {
  bookingId: string;
  eventSessionId: string;
  provider: string;
  lines: Array<{ ticketTypeId: string; quantity: number }>;
  /** ISO-8601 instant the hold expires if unpaid. */
  holdExpiresAt: string;
}
export type InventoryLockedEvent = DomainEvent<InventoryLockedPayload>;

export function inventoryLockedEvent(
  payload: InventoryLockedPayload,
  tracing: EventTracing = {},
): InventoryLockedEvent {
  return DomainEventFactory.create<InventoryLockedPayload>({
    eventType: DomainEventType.InventoryLocked,
    eventVersion: DomainEventVersion[DomainEventType.InventoryLocked],
    aggregateType: 'EventSession',
    aggregateId: payload.eventSessionId,
    ...tracing,
    payload,
  });
}

export interface InventoryReleasedPayload {
  bookingId: string;
  eventSessionId: string;
  provider: string;
  lines: Array<{ ticketTypeId: string; quantity: number }>;
  /** Why the hold was released, e.g. "expired" | "cancelled". */
  reason: string;
  releasedAt: string;
}
export type InventoryReleasedEvent = DomainEvent<InventoryReleasedPayload>;

export function inventoryReleasedEvent(
  payload: InventoryReleasedPayload,
  tracing: EventTracing = {},
): InventoryReleasedEvent {
  return DomainEventFactory.create<InventoryReleasedPayload>({
    eventType: DomainEventType.InventoryReleased,
    eventVersion: DomainEventVersion[DomainEventType.InventoryReleased],
    aggregateType: 'EventSession',
    aggregateId: payload.eventSessionId,
    ...tracing,
    payload,
  });
}
