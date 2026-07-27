import type { DomainEvent } from '../domain-event';
import { DomainEventFactory } from '../domain-event.factory';
import { DomainEventType, DomainEventVersion, type EventTracing } from './event-types';

/**
 * Booking lifecycle facts. Payloads carry IDENTIFIERS AND FACTS ONLY — no buyer name,
 * email, payment card data, secrets, or raw provider payloads. Amounts are minor-unit
 * strings to avoid float drift. See ADR-038 + the event catalogue.
 */

export interface BookingConfirmedPayload {
  bookingId: string;
  userId: string;
  experienceId: string;
  showId?: string;
  /** Total charged, in minor units, as a string (e.g. "150000"). */
  amount: string;
  currency: string;
  ticketCount: number;
  /** ISO-8601 instant the booking became CONFIRMED. */
  confirmedAt: string;
}
export type BookingConfirmedEvent = DomainEvent<BookingConfirmedPayload>;

export function bookingConfirmedEvent(
  payload: BookingConfirmedPayload,
  tracing: EventTracing = {},
): BookingConfirmedEvent {
  return DomainEventFactory.create<BookingConfirmedPayload>({
    eventType: DomainEventType.BookingConfirmed,
    eventVersion: DomainEventVersion[DomainEventType.BookingConfirmed],
    aggregateType: 'Booking',
    aggregateId: payload.bookingId,
    actorId: tracing.actorId ?? payload.userId,
    ...tracing,
    payload,
  });
}

export interface BookingCancelledPayload {
  bookingId: string;
  userId: string;
  experienceId: string;
  reason?: string;
  cancelledAt: string;
}
export type BookingCancelledEvent = DomainEvent<BookingCancelledPayload>;

export function bookingCancelledEvent(
  payload: BookingCancelledPayload,
  tracing: EventTracing = {},
): BookingCancelledEvent {
  return DomainEventFactory.create<BookingCancelledPayload>({
    eventType: DomainEventType.BookingCancelled,
    eventVersion: DomainEventVersion[DomainEventType.BookingCancelled],
    aggregateType: 'Booking',
    aggregateId: payload.bookingId,
    actorId: tracing.actorId ?? payload.userId,
    ...tracing,
    payload,
  });
}

export interface BookingExpiredPayload {
  bookingId: string;
  experienceId: string;
  /** ISO-8601 instant the hold expired. */
  expiredAt: string;
}
export type BookingExpiredEvent = DomainEvent<BookingExpiredPayload>;

export function bookingExpiredEvent(
  payload: BookingExpiredPayload,
  tracing: EventTracing = {},
): BookingExpiredEvent {
  return DomainEventFactory.create<BookingExpiredPayload>({
    eventType: DomainEventType.BookingExpired,
    eventVersion: DomainEventVersion[DomainEventType.BookingExpired],
    aggregateType: 'Booking',
    aggregateId: payload.bookingId,
    ...tracing,
    payload,
  });
}
