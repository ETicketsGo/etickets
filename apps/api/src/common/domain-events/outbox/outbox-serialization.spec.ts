import { serializeEvent, deserializeEvent } from './outbox-serialization';
import { DomainEventFactory } from '../domain-event.factory';
import {
  OutboxPayloadTooLargeError,
  OutboxSerializationError,
  OutboxUnsupportedVersionError,
} from './outbox.errors';

const evt = (over: Record<string, unknown> = {}) =>
  DomainEventFactory.create({
    eventType: 'booking.confirmed',
    aggregateType: 'Booking',
    aggregateId: 'b1',
    correlationId: 'c1',
    causationId: 'p1',
    actorId: 'u1',
    tenantId: 't1',
    payload: { bookingId: 'b1', amount: '150000', currency: 'INR' },
    ...over,
  });

describe('outbox serialization', () => {
  it('round-trips the envelope, preserving minor-unit strings + correlation/causation/tenant/actor', () => {
    const event = evt();
    const row = serializeEvent(event, 262144);
    const back = deserializeEvent({ ...row, occurredAt: row.occurredAt });
    expect(back.eventId).toBe(event.eventId);
    expect(back.correlationId).toBe('c1');
    expect(back.causationId).toBe('p1');
    expect(back.actorId).toBe('u1');
    expect(back.tenantId).toBe('t1');
    expect(back.occurredAt).toBeInstanceOf(Date);
    // Minor-unit monetary string preserved EXACTLY (not coerced to a number).
    expect((back.payload as { amount: string }).amount).toBe('150000');
    expect(row.payloadHash).toHaveLength(64);
  });

  it('rejects an over-size payload', () => {
    const big = evt({ payload: { blob: 'x'.repeat(5000) } });
    expect(() => serializeEvent(big, 1000)).toThrow(OutboxPayloadTooLargeError);
  });

  it('rejects a non-serializable payload (BigInt)', () => {
    const bad = evt({ payload: { n: BigInt(1) } as unknown as object });
    expect(() => serializeEvent(bad, 262144)).toThrow(OutboxSerializationError);
  });

  it('rejects a version newer than the registered catalogue version on read', () => {
    const row = serializeEvent(evt(), 262144);
    expect(() => deserializeEvent({ ...row, eventVersion: 99 })).toThrow(
      OutboxUnsupportedVersionError,
    );
  });
});
