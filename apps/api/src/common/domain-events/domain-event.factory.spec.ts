import { DomainEventFactory } from './domain-event.factory';
import { InvalidDomainEventError } from './domain-event.errors';
import type { DomainEvent } from './domain-event';

const valid = {
  eventType: 'booking.confirmed',
  aggregateType: 'Booking',
  aggregateId: 'bk_1',
  payload: { bookingId: 'bk_1' },
};

describe('DomainEventFactory.create', () => {
  it('stamps a unique eventId, occurredAt and default version 1', () => {
    const a = DomainEventFactory.create(valid);
    const b = DomainEventFactory.create(valid);
    expect(a.eventId).toBeTruthy();
    expect(a.eventId).not.toBe(b.eventId); // unique per occurrence
    expect(a.eventVersion).toBe(1);
    expect(a.occurredAt).toBeInstanceOf(Date);
  });

  it('honours an explicit version and passes through tracing fields', () => {
    const e = DomainEventFactory.create({
      ...valid,
      eventVersion: 2,
      correlationId: 'corr_1',
      actorId: 'user_1',
      tenantId: 'org_1',
    });
    expect(e.eventVersion).toBe(2);
    expect(e.correlationId).toBe('corr_1');
    expect(e.actorId).toBe('user_1');
    expect(e.tenantId).toBe('org_1');
  });

  it.each([
    ['missing eventType', { ...valid, eventType: '' }],
    ['blank aggregateType', { ...valid, aggregateType: '  ' }],
    ['missing aggregateId', { ...valid, aggregateId: '' }],
    ['null payload', { ...valid, payload: null as unknown as object }],
  ])('rejects an invalid envelope (%s)', (_label, input) => {
    expect(() => DomainEventFactory.create(input)).toThrow(InvalidDomainEventError);
  });

  it('rejects a non-positive / non-integer version', () => {
    expect(() => DomainEventFactory.create({ ...valid, eventVersion: 0 })).toThrow(
      InvalidDomainEventError,
    );
    expect(() => DomainEventFactory.create({ ...valid, eventVersion: 1.5 })).toThrow(
      InvalidDomainEventError,
    );
  });
});

describe('DomainEventFactory.createCausedBy (correlation & causation)', () => {
  it('preserves the parent correlationId and records causationId = parent.eventId', () => {
    const parent = DomainEventFactory.create({
      ...valid,
      correlationId: 'corr_root',
      actorId: 'user_1',
      tenantId: 'org_1',
    });
    const child = DomainEventFactory.createCausedBy(parent, {
      eventType: 'booking.confirmed',
      aggregateType: 'Booking',
      aggregateId: 'bk_1',
      payload: { bookingId: 'bk_1' },
    });
    expect(child.correlationId).toBe('corr_root');
    expect(child.causationId).toBe(parent.eventId);
    expect(child.actorId).toBe('user_1'); // carried over
    expect(child.tenantId).toBe('org_1');
  });

  it('falls back to the parent eventId as the correlationId when the parent had none', () => {
    const parent = DomainEventFactory.create(valid) as DomainEvent;
    const child = DomainEventFactory.createCausedBy(parent, valid);
    expect(child.correlationId).toBe(parent.eventId);
    expect(child.causationId).toBe(parent.eventId);
  });
});
