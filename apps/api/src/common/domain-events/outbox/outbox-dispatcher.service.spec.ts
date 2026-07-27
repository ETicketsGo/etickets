import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../../../metrics/metrics.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxDispatcher } from './outbox-dispatcher.service';
import type { OutboxDeliveryAdapter } from './outbox-delivery.adapter';
import { OutboxDeliveryPermanentError } from './outbox.errors';

const CFG: Record<string, unknown> = {
  DOMAIN_EVENT_OUTBOX_DISPATCH_ENABLED: true,
  DOMAIN_EVENT_OUTBOX_BATCH_SIZE: 100,
  DOMAIN_EVENT_OUTBOX_LEASE_SECONDS: 60,
  DOMAIN_EVENT_OUTBOX_BASE_RETRY_SECONDS: 5,
  DOMAIN_EVENT_OUTBOX_MAX_RETRY_SECONDS: 3600,
};

const claimedRow = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  eventId: 'e1',
  eventType: 'booking.confirmed',
  eventVersion: 1,
  aggregateType: 'Booking',
  aggregateId: 'b1',
  occurredAt: new Date(),
  correlationId: null,
  causationId: null,
  actorId: null,
  tenantId: null,
  payloadJson: { bookingId: 'b1' },
  metadataJson: null,
  attemptCount: 1,
  maxAttempts: 12,
  ...over,
});

function make(opts: { enabled?: boolean; rows?: unknown[]; deliver?: () => Promise<void> } = {}) {
  const updates: Array<Record<string, unknown>> = [];
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue(opts.rows ?? []),
    outboxEvent: {
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return data;
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
  } as unknown as PrismaService;
  const config = {
    get: jest.fn((k: string, d?: unknown) =>
      opts.enabled === false && k.includes('DISPATCH_ENABLED') ? false : (CFG[k] ?? d),
    ),
  } as unknown as ConfigService;
  const adapter = {
    name: 'test',
    deliver: jest.fn(opts.deliver ?? (async () => undefined)),
  } as unknown as OutboxDeliveryAdapter;
  const dispatcher = new OutboxDispatcher(prisma, config, new MetricsService(), adapter);
  return { dispatcher, prisma, updates, adapter };
}

describe('OutboxDispatcher', () => {
  it('no-ops (no claim) when dispatch is disabled', async () => {
    const { dispatcher, prisma } = make({ enabled: false });
    const r = await dispatcher.dispatchBatch();
    expect(r).toEqual({ claimed: 0, delivered: 0, failed: 0 });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('marks a successfully delivered row DELIVERED', async () => {
    const { dispatcher, updates } = make({ rows: [claimedRow()] });
    const r = await dispatcher.dispatchBatch();
    expect(r.delivered).toBe(1);
    expect(updates.at(-1)).toMatchObject({ status: 'DELIVERED' });
  });

  it('schedules a retry with backoff on a retryable failure', async () => {
    const { dispatcher, updates } = make({
      rows: [claimedRow()],
      deliver: async () => {
        throw new Error('temporary');
      },
    });
    await dispatcher.dispatchBatch();
    expect(updates.at(-1)).toMatchObject({ status: 'RETRYABLE_FAILURE' });
    expect(updates.at(-1)?.availableAt).toBeInstanceOf(Date);
  });

  it('dead-letters once max attempts is reached', async () => {
    const { dispatcher, updates } = make({
      rows: [claimedRow({ attemptCount: 12, maxAttempts: 12 })],
      deliver: async () => {
        throw new Error('still failing');
      },
    });
    await dispatcher.dispatchBatch();
    expect(updates.at(-1)).toMatchObject({ status: 'DEAD_LETTERED' });
  });

  it('dead-letters a permanent failure immediately', async () => {
    const { dispatcher, updates } = make({
      rows: [claimedRow()],
      deliver: async () => {
        throw new OutboxDeliveryPermanentError('bad');
      },
    });
    await dispatcher.dispatchBatch();
    expect(updates.at(-1)).toMatchObject({ status: 'DEAD_LETTERED' });
  });

  it('sends an unsupported-version row to MANUAL_REVIEW (deserialize rejects before delivery)', async () => {
    const { dispatcher, updates, adapter } = make({ rows: [claimedRow({ eventVersion: 99 })] });
    await dispatcher.dispatchBatch();
    expect(updates.at(-1)).toMatchObject({ status: 'MANUAL_REVIEW' });
    expect(adapter.deliver).not.toHaveBeenCalled();
  });

  it('recovers stale leases', async () => {
    const { dispatcher } = make();
    expect(await dispatcher.recoverStaleLeases()).toBe(2);
  });
});
