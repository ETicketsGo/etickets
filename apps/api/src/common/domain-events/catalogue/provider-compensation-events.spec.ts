import { DomainEventVersion, DomainEventType } from './event-types';
import {
  bookingProviderReservationCreatedEvent,
  bookingProviderConfirmedEvent,
  bookingProviderConfirmationAmbiguousEvent,
  bookingAllocationConsumptionConfirmedEvent,
  bookingCompensationRequiredEvent,
  bookingCompensationPlannedEvent,
} from './provider-compensation-events';

const now = '2026-07-28T00:00:00.000Z';

describe('provider/allocation/compensation event builders', () => {
  it('stamps type + version 1 and Booking aggregate identity', () => {
    const e = bookingProviderReservationCreatedEvent({
      bookingId: 'b1',
      workflowId: 'wf1',
      providerCode: 'mock-external-booking',
      ownershipMode: 'PROVIDER_AUTHORITATIVE',
      inventoryType: 'SEAT',
      category: 'RESERVED',
      occurredAt: now,
    });
    expect(e.eventType).toBe(DomainEventType.BookingProviderReservationCreated);
    expect(e.eventVersion).toBe(
      DomainEventVersion[DomainEventType.BookingProviderReservationCreated],
    );
    expect(e.aggregateType).toBe('Booking');
    expect(e.aggregateId).toBe('b1');
    expect(e.occurredAt instanceof Date).toBe(true);
  });

  it('carries only safe fields — never PII, secrets, or raw provider payloads', () => {
    const e = bookingProviderConfirmedEvent({
      bookingId: 'b1',
      providerCode: 'mock-external-booking',
      ownershipMode: 'PROVIDER_AUTHORITATIVE',
      category: 'CONFIRMED',
      occurredAt: now,
    });
    const keys = Object.keys(e.payload);
    for (const forbidden of ['email', 'phone', 'card', 'secret', 'rawResponse', 'buyerName']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('propagates correlation id via tracing', () => {
    const e = bookingProviderConfirmationAmbiguousEvent(
      {
        bookingId: 'b1',
        providerCode: 'p',
        ownershipMode: 'PROVIDER_AUTHORITATIVE',
        occurredAt: now,
      },
      { correlationId: 'corr-1' },
    );
    expect(e.correlationId).toBe('corr-1');
  });

  it('builds allocation + compensation events at version 1', () => {
    const alloc = bookingAllocationConsumptionConfirmedEvent({
      bookingId: 'b1',
      providerCode: 'p',
      ownershipMode: 'ALLOCATED',
      inventoryType: 'QUANTITY',
      quantity: 2,
      occurredAt: now,
    });
    expect(alloc.eventType).toBe(DomainEventType.BookingAllocationConsumptionConfirmed);
    const req = bookingCompensationRequiredEvent({
      bookingId: 'b1',
      reasonCode: 'PROVIDER_CONFIRMATION_REJECTED',
      occurredAt: now,
    });
    const planned = bookingCompensationPlannedEvent({
      bookingId: 'b1',
      compensationType: 'PAYMENT_REFUND',
      occurredAt: now,
    });
    expect(req.eventType).toBe(DomainEventType.BookingCompensationRequired);
    expect(planned.eventType).toBe(DomainEventType.BookingCompensationPlanned);
    expect(planned.aggregateType).toBe('Booking');
  });
});
