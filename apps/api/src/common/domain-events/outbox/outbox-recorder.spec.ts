import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { MetricsService } from '../../../metrics/metrics.service';
import { OutboxRecorder } from './outbox-recorder';
import { OutboxPayloadTooLargeError } from './outbox.errors';
import { DomainEventFactory } from '../domain-event.factory';

const evt = (over: Record<string, unknown> = {}) =>
  DomainEventFactory.create({
    eventType: 'booking.confirmed',
    aggregateType: 'Booking',
    aggregateId: 'b1',
    payload: { bookingId: 'b1' },
    ...over,
  });

function make(maxBytes = 262144, createCount = 2) {
  const createMany = jest.fn().mockResolvedValue({ count: createCount });
  const tx = { outboxEvent: { createMany } } as unknown as Prisma.TransactionClient;
  const config = {
    get: jest.fn((k: string, d?: unknown) =>
      k === 'DOMAIN_EVENT_OUTBOX_MAX_PAYLOAD_BYTES'
        ? maxBytes
        : k === 'DOMAIN_EVENT_OUTBOX_MAX_ATTEMPTS'
          ? 12
          : d,
    ),
  } as unknown as ConfigService;
  return { recorder: new OutboxRecorder(config, new MetricsService()), tx, createMany };
}

describe('OutboxRecorder', () => {
  it('inserts one row per event with skipDuplicates + shadow flag', async () => {
    const { recorder, tx, createMany } = make(262144, 2);
    const n = await recorder.recordMany(tx, [evt(), evt()], true);
    expect(n).toBe(2);
    expect(createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
    const rows = (createMany.mock.calls[0][0] as { data: Array<{ shadow: boolean }> }).data;
    expect(rows.every((r) => r.shadow === true)).toBe(true);
  });

  it('returns the inserted count (a duplicate eventId is skipped, not a second row)', async () => {
    const { recorder, tx } = make(262144, 1); // createMany reports 1 of 2 inserted
    expect(await recorder.recordMany(tx, [evt(), evt()], false)).toBe(1);
  });

  it('propagates a serialization failure so the business transaction rolls back', async () => {
    const { recorder, tx } = make(10); // tiny limit forces payload-too-large
    await expect(
      recorder.recordMany(tx, [evt({ payload: { blob: 'x'.repeat(500) } })], false),
    ).rejects.toBeInstanceOf(OutboxPayloadTooLargeError);
  });

  it('is a no-op for an empty list', async () => {
    const { recorder, tx, createMany } = make();
    expect(await recorder.recordMany(tx, [], false)).toBe(0);
    expect(createMany).not.toHaveBeenCalled();
  });
});
