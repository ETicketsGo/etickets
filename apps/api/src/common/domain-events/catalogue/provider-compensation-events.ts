import type { DomainEvent } from '../domain-event';
import { DomainEventFactory } from '../domain-event.factory';
import {
  DomainEventType,
  DomainEventVersion,
  type DomainEventTypeName,
  type EventTracing,
} from './event-types';

/**
 * Provider-authoritative, allocated-inventory, and compensation lifecycle facts (ADR-042
 * §8/§9 + ADR-043, P5.3A). Completed FACTS only — never disguised synchronous commands.
 * Payloads carry identifiers + safe categories only: NO raw provider payloads, secrets,
 * customer email/phone, payment credentials, or unbounded error strings. Amounts are minor-
 * unit strings. All start at schema version 1. See docs/architecture/EVENT-CATALOGUE.
 */

/** Fields common to every provider/allocation/compensation event (all safe). */
export interface BookingProviderEventBase {
  bookingId: string;
  workflowId?: string;
  providerCode: string;
  ownershipMode: 'PROVIDER_AUTHORITATIVE' | 'ALLOCATED';
  inventoryType?: 'SEAT' | 'QUANTITY';
  /** Normalized outcome/reservation/status category (bounded vocabulary). */
  category?: string;
  attempt?: number;
  /** ISO-8601 instant the fact occurred. */
  occurredAt: string;
}

function providerEvent<P extends { bookingId: string }>(
  type: DomainEventTypeName,
  payload: P,
  tracing: EventTracing,
): DomainEvent<P> {
  return DomainEventFactory.create<P>({
    eventType: type,
    eventVersion: DomainEventVersion[type],
    aggregateType: 'Booking',
    aggregateId: payload.bookingId,
    ...tracing,
    payload,
  });
}

// ── Provider-authoritative ──
export const bookingProviderReservationCreatedEvent = (
  p: BookingProviderEventBase,
  t: EventTracing = {},
) => providerEvent(DomainEventType.BookingProviderReservationCreated, p, t);
export const bookingProviderReservationRejectedEvent = (
  p: BookingProviderEventBase,
  t: EventTracing = {},
) => providerEvent(DomainEventType.BookingProviderReservationRejected, p, t);
export const bookingProviderReservationExpiredEvent = (
  p: BookingProviderEventBase,
  t: EventTracing = {},
) => providerEvent(DomainEventType.BookingProviderReservationExpired, p, t);
export const bookingProviderConfirmedEvent = (p: BookingProviderEventBase, t: EventTracing = {}) =>
  providerEvent(DomainEventType.BookingProviderConfirmed, p, t);
export const bookingProviderConfirmationAmbiguousEvent = (
  p: BookingProviderEventBase,
  t: EventTracing = {},
) => providerEvent(DomainEventType.BookingProviderConfirmationAmbiguous, p, t);
export const bookingProviderStatusRecoveredEvent = (
  p: BookingProviderEventBase,
  t: EventTracing = {},
) => providerEvent(DomainEventType.BookingProviderStatusRecovered, p, t);
export const bookingProviderCancelledEvent = (p: BookingProviderEventBase, t: EventTracing = {}) =>
  providerEvent(DomainEventType.BookingProviderCancelled, p, t);

// ── Allocated inventory ──
export interface BookingAllocationEventPayload extends BookingProviderEventBase {
  allocationId?: string;
  /** Summarized booking-level consumption delta (avoid per-seat storms). */
  quantity?: number;
}
export const bookingAllocationValidatedEvent = (
  p: BookingAllocationEventPayload,
  t: EventTracing = {},
) => providerEvent(DomainEventType.BookingAllocationValidated, p, t);
export const bookingAllocationRejectedEvent = (
  p: BookingAllocationEventPayload,
  t: EventTracing = {},
) => providerEvent(DomainEventType.BookingAllocationRejected, p, t);
export const bookingAllocationConsumptionHeldEvent = (
  p: BookingAllocationEventPayload,
  t: EventTracing = {},
) => providerEvent(DomainEventType.BookingAllocationConsumptionHeld, p, t);
export const bookingAllocationConsumptionConfirmedEvent = (
  p: BookingAllocationEventPayload,
  t: EventTracing = {},
) => providerEvent(DomainEventType.BookingAllocationConsumptionConfirmed, p, t);
export const bookingAllocationConsumptionReleasedEvent = (
  p: BookingAllocationEventPayload,
  t: EventTracing = {},
) => providerEvent(DomainEventType.BookingAllocationConsumptionReleased, p, t);
export const bookingAllocationReconciliationRequiredEvent = (
  p: BookingAllocationEventPayload,
  t: EventTracing = {},
) => providerEvent(DomainEventType.BookingAllocationReconciliationRequired, p, t);

// ── Compensation lifecycle (ADR-043) ──
export interface BookingCompensationEventPayload {
  bookingId: string;
  workflowId?: string;
  compensationId?: string;
  compensationType?: string;
  reasonCode?: string;
  /** Amount in minor units, as a string, when a money-related plan exists. */
  amount?: string;
  currency?: string;
  attempt?: number;
  occurredAt: string;
}
function compEvent(type: DomainEventTypeName, p: BookingCompensationEventPayload, t: EventTracing) {
  return DomainEventFactory.create<BookingCompensationEventPayload>({
    eventType: type,
    eventVersion: DomainEventVersion[type],
    aggregateType: 'Booking',
    aggregateId: p.bookingId,
    ...t,
    payload: p,
  });
}
export const bookingCompensationRequiredEvent = (
  p: BookingCompensationEventPayload,
  t: EventTracing = {},
) => compEvent(DomainEventType.BookingCompensationRequired, p, t);
export const bookingCompensationPlannedEvent = (
  p: BookingCompensationEventPayload,
  t: EventTracing = {},
) => compEvent(DomainEventType.BookingCompensationPlanned, p, t);
export const bookingCompensationStartedEvent = (
  p: BookingCompensationEventPayload,
  t: EventTracing = {},
) => compEvent(DomainEventType.BookingCompensationStarted, p, t);
export const bookingCompensationCompletedEvent = (
  p: BookingCompensationEventPayload,
  t: EventTracing = {},
) => compEvent(DomainEventType.BookingCompensationCompleted, p, t);
export const bookingCompensationRetryScheduledEvent = (
  p: BookingCompensationEventPayload,
  t: EventTracing = {},
) => compEvent(DomainEventType.BookingCompensationRetryScheduled, p, t);
export const bookingCompensationFailedEvent = (
  p: BookingCompensationEventPayload,
  t: EventTracing = {},
) => compEvent(DomainEventType.BookingCompensationFailed, p, t);
export const bookingCompensationDeadLetteredEvent = (
  p: BookingCompensationEventPayload,
  t: EventTracing = {},
) => compEvent(DomainEventType.BookingCompensationDeadLettered, p, t);
export const bookingManualReviewRequiredEvent = (
  p: BookingCompensationEventPayload,
  t: EventTracing = {},
) => compEvent(DomainEventType.BookingManualReviewRequired, p, t);
