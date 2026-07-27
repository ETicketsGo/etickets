import { PrismaService } from '../../prisma/prisma.service';
import { DomainEventFactory } from './domain-event.factory';
import { TransactionalEventPublisher } from './transactional-event-publisher';
import type { DomainEventBus } from './domain-event-bus';

function setup(opts: { publishRejects?: boolean } = {}) {
  const trace: string[] = [];
  const bus = {
    publish: jest.fn(),
    subscribe: jest.fn(),
    publishMany: jest.fn(async () => {
      trace.push('publish');
      if (opts.publishRejects) throw new Error('transport down');
    }),
  } as unknown as DomainEventBus;
  // Interactive $transaction: run the callback with a fake tx; a throwing callback
  // rejects (mimicking a rollback), exactly like Prisma.
  const prisma = {
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb({})),
  } as unknown as PrismaService;
  const publisher = new TransactionalEventPublisher(prisma, bus);
  return { publisher, bus, prisma, trace };
}

const evt = (id?: string) =>
  DomainEventFactory.create({
    eventId: id,
    eventType: 'booking.confirmed',
    aggregateType: 'Booking',
    aggregateId: 'bk_1',
    payload: { bookingId: 'bk_1' },
  });

describe('TransactionalEventPublisher.runWithEvents', () => {
  it('publishes collected events ONLY AFTER the transaction commits', async () => {
    const { publisher, bus, trace } = setup();
    const result = await publisher.runWithEvents(async (_tx, collector) => {
      trace.push('work');
      collector.collect(evt('e1'));
      return 'done';
    });
    expect(result).toBe('done');
    expect(trace).toEqual(['work', 'publish']); // publish strictly after work/commit
    expect(bus.publishMany).toHaveBeenCalledTimes(1);
    const published = (bus.publishMany as jest.Mock).mock.calls[0][0];
    expect(published.map((e: { eventId: string }) => e.eventId)).toEqual(['e1']);
  });

  it('DISCARDS collected events when the transaction rolls back', async () => {
    const { publisher, bus } = setup();
    await expect(
      publisher.runWithEvents(async (_tx, collector) => {
        collector.collect(evt('e1'));
        throw new Error('domain failure');
      }),
    ).rejects.toThrow('domain failure');
    expect(bus.publishMany).not.toHaveBeenCalled(); // never published
  });

  it('preserves deterministic ordering of multiple collected events', async () => {
    const { publisher, bus } = setup();
    await publisher.runWithEvents(async (_tx, collector) => {
      collector.collect(evt('e1'));
      collector.collect(evt('e2'));
    });
    const published = (bus.publishMany as jest.Mock).mock.calls[0][0];
    expect(published.map((e: { eventId: string }) => e.eventId)).toEqual(['e1', 'e2']);
  });

  it('post-commit publication failure does NOT roll back / throw (commit stands)', async () => {
    const { publisher } = setup({ publishRejects: true });
    // The work committed; publication then fails — runWithEvents must still resolve.
    await expect(
      publisher.runWithEvents(async (_tx, collector) => {
        collector.collect(evt('e1'));
        return 'committed';
      }),
    ).resolves.toBe('committed');
  });
});

describe('TransactionalEventPublisher.publishAfterCommit', () => {
  it('publishes already-committed events', async () => {
    const { publisher, bus } = setup();
    await publisher.publishAfterCommit([evt('e1')]);
    expect(bus.publishMany).toHaveBeenCalledTimes(1);
  });

  it('swallows a publication failure (never throws for a committed change)', async () => {
    const { publisher } = setup({ publishRejects: true });
    await expect(publisher.publishAfterCommit([evt('e1')])).resolves.toBeUndefined();
  });

  it('is a no-op for an empty event list', async () => {
    const { publisher, bus } = setup();
    await publisher.publishAfterCommit([]);
    expect(bus.publishMany).not.toHaveBeenCalled();
  });
});
