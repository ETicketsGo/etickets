import type { DomainEvent } from '../domain-event';
import { DomainEventFactory } from '../domain-event.factory';
import { DomainEventType, DomainEventVersion, type EventTracing } from './event-types';

/**
 * External-sync domain facts (ADR-040). Payloads carry SAFE identifiers + counts only
 * — never raw provider payloads, PII, secrets, or per-seat detail. Large seat-map
 * changes publish a single SUMMARY event with counts, not one event per seat.
 */

function build<T extends object>(
  type: (typeof DomainEventType)[keyof typeof DomainEventType],
  aggregateType: string,
  aggregateId: string,
  payload: T,
  tracing: EventTracing,
): DomainEvent<T> {
  return DomainEventFactory.create<T>({
    eventType: type,
    eventVersion: DomainEventVersion[type],
    aggregateType,
    aggregateId,
    ...tracing,
    payload,
  });
}

export interface SessionSyncPayload {
  providerCode: string;
  externalSessionId: string;
  internalSessionId?: string;
  status?: string;
}
export const sessionUpdatedEvent = (p: SessionSyncPayload, t: EventTracing = {}) =>
  build(DomainEventType.SessionUpdated, 'ProviderSession', p.externalSessionId, p, t);
export const sessionCancelledEvent = (p: SessionSyncPayload, t: EventTracing = {}) =>
  build(DomainEventType.SessionCancelled, 'ProviderSession', p.externalSessionId, p, t);

export interface SeatAvailabilitySyncPayload {
  providerCode: string;
  externalSessionId: string;
  /** Summary counts only — never per-seat detail. */
  changedSeats: number;
  version: number;
}
export const seatAvailabilityUpdatedEvent = (
  p: SeatAvailabilitySyncPayload,
  t: EventTracing = {},
) => build(DomainEventType.SeatAvailabilityUpdated, 'ProviderSession', p.externalSessionId, p, t);

export interface QuantityAvailabilitySyncPayload {
  providerCode: string;
  externalSessionId: string;
  remaining: number;
  version: number;
}
export const quantityAvailabilityUpdatedEvent = (
  p: QuantityAvailabilitySyncPayload,
  t: EventTracing = {},
) =>
  build(DomainEventType.QuantityAvailabilityUpdated, 'ProviderSession', p.externalSessionId, p, t);

export interface PricingSyncPayload {
  providerCode: string;
  externalSessionId: string;
  tiers: number;
}
export const pricingUpdatedEvent = (p: PricingSyncPayload, t: EventTracing = {}) =>
  build(DomainEventType.PricingUpdated, 'ProviderSession', p.externalSessionId, p, t);

export interface ExperienceSyncPayload {
  providerCode: string;
  externalExperienceId: string;
  internalExperienceId?: string;
}
export const experienceUpdatedEvent = (p: ExperienceSyncPayload, t: EventTracing = {}) =>
  build(DomainEventType.ExperienceUpdated, 'ProviderExperience', p.externalExperienceId, p, t);

export interface MappingReviewPayload {
  providerCode: string;
  externalEntityType: string;
  externalEntityId: string;
  reason: string;
}
export const providerMappingReviewRequiredEvent = (p: MappingReviewPayload, t: EventTracing = {}) =>
  build(DomainEventType.ProviderMappingReviewRequired, 'ProviderMapping', p.externalEntityId, p, t);

export interface SyncLifecyclePayload {
  providerCode: string;
  rawEventId?: string;
  applied?: number;
  ignored?: number;
  reason?: string;
}
export const inventorySyncCompletedEvent = (p: SyncLifecyclePayload, t: EventTracing = {}) =>
  build(
    DomainEventType.InventorySyncCompleted,
    'InventorySync',
    p.rawEventId ?? p.providerCode,
    p,
    t,
  );
export const inventorySyncFailedEvent = (p: SyncLifecyclePayload, t: EventTracing = {}) =>
  build(DomainEventType.InventorySyncFailed, 'InventorySync', p.rawEventId ?? p.providerCode, p, t);

export interface ProviderHealthChangedPayload {
  providerCode: string;
  state: string;
  previous?: string;
}
export const providerHealthChangedEvent = (p: ProviderHealthChangedPayload, t: EventTracing = {}) =>
  build(DomainEventType.ProviderHealthChanged, 'Provider', p.providerCode, p, t);
