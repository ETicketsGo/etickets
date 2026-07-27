import type { DomainEvent } from '../domain-event';
import { DomainEventFactory } from '../domain-event.factory';
import { DomainEventType, DomainEventVersion, type EventTracing } from './event-types';

/** Refund lifecycle fact. Amounts are minor-unit strings; no card/provider secrets. */
export interface RefundProcessedPayload {
  refundId: string;
  bookingId: string;
  /** Refunded amount in minor units, as a string. */
  amount: string;
  currency: string;
  /** Whether the whole booking was refunded (vs a partial refund). */
  full: boolean;
  processedAt: string;
}
export type RefundProcessedEvent = DomainEvent<RefundProcessedPayload>;

export function refundProcessedEvent(
  payload: RefundProcessedPayload,
  tracing: EventTracing = {},
): RefundProcessedEvent {
  return DomainEventFactory.create<RefundProcessedPayload>({
    eventType: DomainEventType.RefundProcessed,
    eventVersion: DomainEventVersion[DomainEventType.RefundProcessed],
    aggregateType: 'Booking',
    aggregateId: payload.bookingId,
    ...tracing,
    payload,
  });
}
