import type { DomainEvent } from '../domain-event';
import { DomainEventFactory } from '../domain-event.factory';
import { DomainEventType, DomainEventVersion, type EventTracing } from './event-types';

/** Check-in fact. Identifiers only — no holder name/email (that stays in the ticket). */
export interface TicketCheckedInPayload {
  ticketId: string;
  bookingId: string;
  eventSessionId: string;
  /** The gate/device that recorded the scan, for audit + occupancy analytics. */
  gateId?: string;
  deviceId?: string;
  checkedInAt: string;
}
export type TicketCheckedInEvent = DomainEvent<TicketCheckedInPayload>;

export function ticketCheckedInEvent(
  payload: TicketCheckedInPayload,
  tracing: EventTracing = {},
): TicketCheckedInEvent {
  return DomainEventFactory.create<TicketCheckedInPayload>({
    eventType: DomainEventType.TicketCheckedIn,
    eventVersion: DomainEventVersion[DomainEventType.TicketCheckedIn],
    aggregateType: 'Ticket',
    aggregateId: payload.ticketId,
    ...tracing,
    payload,
  });
}
