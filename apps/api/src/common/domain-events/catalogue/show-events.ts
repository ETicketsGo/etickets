import { DomainEventType, DomainEventVersion, type EventTracing } from './event-types';
import { DomainEventFactory } from '../domain-event.factory';
import type { DomainEvent } from '../domain-event';

/**
 * A show this platform runs was called off.
 *
 * ── WHY THIS REUSES `session.cancelled` RATHER THAN ADDING A TYPE ──────────────────
 * The fact is the same one: a session that people hold tickets for is not happening. There
 * was already a builder for it, but only for the SYNC direction — an external provider
 * telling us one of THEIR sessions was cancelled, keyed on `externalSessionId` under the
 * `ProviderSession` aggregate. A show an organizer cancels in our own console is the same
 * fact about a different aggregate.
 *
 * So the discriminator is `aggregateType`, which is exactly what it is for: `ProviderSession`
 * means the news came from a vendor's feed and may concern no local booking at all;
 * `EventSession` means one of ours, with customers who paid us. A handler that cares about
 * only one reads the aggregate rather than inventing a second event name for the same event.
 */
export interface ShowCancelledPayload {
  /** Our `EventSession.id`. The aggregate id, repeated for readers that only take payloads. */
  sessionId: string;
  eventId: string;
  organizationId: string;
  /** When the show was due to start, so a message can say which one it was. */
  startsAt: string;
  /** The operator's stated reason. Never shown to a customer verbatim. */
  reason?: string;
  /** How many live bookings existed at the moment of cancellation — for observability only. */
  affectedBookings: number;
}

export type ShowCancelledEvent = DomainEvent<ShowCancelledPayload>;

export const showCancelledEvent = (
  payload: ShowCancelledPayload,
  tracing: EventTracing = {},
): ShowCancelledEvent =>
  DomainEventFactory.create<ShowCancelledPayload>({
    eventType: DomainEventType.SessionCancelled,
    eventVersion: DomainEventVersion[DomainEventType.SessionCancelled],
    // The discriminator. `ProviderSession` is the sync direction; this is ours.
    aggregateType: 'EventSession',
    aggregateId: payload.sessionId,
    ...tracing,
    payload,
  });

/** True when a `session.cancelled` event is about one of OUR shows rather than a vendor feed. */
export function isOurShowCancellation(event: DomainEvent): event is ShowCancelledEvent {
  return event.aggregateType === 'EventSession';
}
