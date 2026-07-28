import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import {
  TransactionalEventPublisher,
  type DomainEventDeliveryMode,
} from './transactional-event-publisher';
import { OutboxRecorder } from './outbox/outbox-recorder';
import { DomainEventFactory } from './domain-event.factory';
import type { DomainEventBus } from './domain-event-bus';

function setup(
  mode: DomainEventDeliveryMode,
  opts: { publishRejects?: boolean; recordThrows?: boolean } = {},
) {
  const trace: string[] = [];
  const bus = {
    publish: jest.fn(),
    subscribe: jest.fn(),
    publishMany: jest.fn(async () => {
      trace.push('publish');
      if (opts.publishRejects) throw new Error('bus down');
    }),
  } as unknown as DomainEventBus;
  const prisma = {
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb({ marker: 'tx' })),
  } as unknown as PrismaService;
  const recorder = {
    recordMany: jest.fn(async () => {
      trace.push('record');
      if (opts.recordThrows) throw new Error('outbox insert failed');
      return 1;
    }),
  } as unknown as OutboxRecorder;
  const config = {
    get: jest.fn((k: string, d?: unknown) => (k === 'DOMAIN_EVENT_DELIVERY_MODE' ? mode : d)),
  } as unknown as ConfigService;
  const publisher = new TransactionalEventPublisher(prisma, bus, config, recorder);
  return { publisher, bus, recorder, trace };
}

const evt = () =>
  DomainEventFactory.create({
    eventType: 'booking.confirmed',
    aggregateType: 'Booking',
    aggregateId: 'b1',
    payload: { bookingId: 'b1' },
  });

describe('TransactionalEventPublisher — modes', () => {
  it('in_process: no outbox record, publishes after commit (unchanged P2 behaviour)', async () => {
    const { publisher, recorder, bus } = setup('in_process');
    await publisher.runWithEvents(async (_tx, c) => c.collect(evt()));
    expect(recorder.recordMany).not.toHaveBeenCalled();
    expect(bus.publishMany).toHaveBeenCalledTimes(1);
  });

  it('outbox: records durably in the tx, does NOT publish directly (dispatcher delivers)', async () => {
    const { publisher, recorder, bus, trace } = setup('outbox');
    await publisher.runWithEvents(async (_tx, c) => c.collect(evt()));
    expect(recorder.recordMany).toHaveBeenCalledTimes(1);
    expect(bus.publishMany).not.toHaveBeenCalled();
    expect(trace).toEqual(['record']); // recorded in-tx, never published
  });

  it('dual_write_shadow: records shadow rows AND publishes directly', async () => {
    const { publisher, recorder, bus } = setup('dual_write_shadow');
    await publisher.runWithEvents(async (_tx, c) => c.collect(evt()));
    expect(recorder.recordMany).toHaveBeenCalledWith(expect.anything(), expect.anything(), true); // shadow=true
    expect(bus.publishMany).toHaveBeenCalledTimes(1);
  });

  it('rollback (work throws) records nothing and publishes nothing', async () => {
    const { publisher, recorder, bus } = setup('outbox');
    await expect(
      publisher.runWithEvents(async () => {
        throw new Error('domain failure');
      }),
    ).rejects.toThrow('domain failure');
    expect(recorder.recordMany).not.toHaveBeenCalled();
    expect(bus.publishMany).not.toHaveBeenCalled();
  });

  it('outbox insert failure rolls back the whole transaction (required-event semantics)', async () => {
    const { publisher, bus } = setup('outbox', { recordThrows: true });
    await expect(publisher.runWithEvents(async (_tx, c) => c.collect(evt()))).rejects.toThrow(
      'outbox insert failed',
    );
    expect(bus.publishMany).not.toHaveBeenCalled();
  });

  it('post-commit publish failure (in_process) does NOT throw — the commit stands', async () => {
    const { publisher } = setup('in_process', { publishRejects: true });
    await expect(
      publisher.runWithEvents(async (_tx, c) => c.collect(evt())),
    ).resolves.toBeUndefined();
  });

  it('recordInTransaction is a no-op in in_process mode and records in outbox mode', async () => {
    const inProc = setup('in_process');
    expect(await inProc.publisher.recordInTransaction({} as never, [evt()])).toBe(0);
    expect(inProc.recorder.recordMany).not.toHaveBeenCalled();

    const outbox = setup('outbox');
    await outbox.publisher.recordInTransaction({} as never, [evt()]);
    expect(outbox.recorder.recordMany).toHaveBeenCalledTimes(1);
  });
});
