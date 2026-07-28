import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../../metrics/metrics.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { DomainEventBus } from '../../common/domain-events';
import { SyncEventProcessor } from './sync-event.processor';
import { InventorySyncProviderRegistry } from './sync-provider.registry';
import { SyncApplicationService } from './sync-application.service';
import {
  ProviderSyncPermanentFailureError,
  ProviderSyncRetryableFailureError,
} from './sync.errors';

function make(
  opts: {
    enabled?: boolean;
    claimCount?: number;
    event?: Record<string, unknown> | null;
    normalize?: () => Promise<unknown>;
    attempt?: number;
  } = {},
) {
  const updates: Array<Record<string, unknown>> = [];
  const prisma = {
    rawProviderEvent: {
      updateMany: jest.fn().mockResolvedValue({ count: opts.claimCount ?? 1 }),
      findUnique: jest.fn().mockResolvedValue(
        opts.event ?? {
          id: 'raw1',
          providerCode: 'mock-aggregator',
          providerTenantId: '',
          eventType: 'session.pricing',
          eventVersion: 1,
          externalEntityId: 's1',
          payloadJson: {},
          attemptCount: opts.attempt ?? 1,
          correlationId: null,
          providerOccurredAt: null,
        },
      ),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return data;
      }),
    },
  } as unknown as PrismaService;
  const provider = {
    providerCode: 'mock-aggregator',
    ownershipMode: 'PROVIDER_AUTHORITATIVE',
    normalize: jest.fn(
      opts.normalize ?? (async () => [{ kind: 'UPDATE_PRICING', externalSessionId: 's1' }]),
    ),
  };
  const registry = {
    get: jest.fn().mockReturnValue(provider),
  } as unknown as InventorySyncProviderRegistry;
  const application = {
    apply: jest.fn().mockResolvedValue({ applied: true }),
  } as unknown as SyncApplicationService;
  const config = {
    get: jest.fn((k: string) => {
      if (k === 'INVENTORY_SYNC_MAX_ATTEMPTS') return 6;
      return opts.enabled !== false;
    }),
  } as unknown as ConfigService;
  const events = { publish: jest.fn().mockResolvedValue(undefined) } as unknown as DomainEventBus;
  const processor = new SyncEventProcessor(
    prisma,
    registry,
    application,
    config,
    new MetricsService(),
    events,
  );
  return { processor, prisma, updates, application };
}

describe('SyncEventProcessor.process', () => {
  it('no-ops when processing is disabled', async () => {
    const { processor, prisma } = make({ enabled: false });
    await processor.process('raw1');
    expect(prisma.rawProviderEvent.updateMany).not.toHaveBeenCalled();
  });

  it('no-ops when the atomic claim is lost (already processed elsewhere)', async () => {
    const { processor, application } = make({ claimCount: 0 });
    await processor.process('raw1');
    expect(application.apply).not.toHaveBeenCalled();
  });

  it('normalizes + applies + marks PROCESSED', async () => {
    const { processor, updates, application } = make();
    await processor.process('raw1');
    expect(application.apply).toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({ processingStatus: 'PROCESSED' });
  });

  it('retryable failure → RETRYABLE_FAILURE + rethrows for BullMQ retry', async () => {
    const { processor, updates } = make({
      normalize: async () => {
        throw new ProviderSyncRetryableFailureError();
      },
    });
    await expect(processor.process('raw1')).rejects.toBeInstanceOf(
      ProviderSyncRetryableFailureError,
    );
    expect(updates.at(-1)).toMatchObject({ processingStatus: 'RETRYABLE_FAILURE' });
  });

  it('permanent failure → PERMANENT_FAILURE and does NOT rethrow (no loop)', async () => {
    const { processor, updates } = make({
      normalize: async () => {
        throw new ProviderSyncPermanentFailureError();
      },
    });
    await expect(processor.process('raw1')).resolves.toBeUndefined();
    expect(updates.at(-1)).toMatchObject({ processingStatus: 'PERMANENT_FAILURE' });
  });

  it('dead-letters a retryable failure once max attempts is reached', async () => {
    const { processor, updates } = make({
      attempt: 6,
      normalize: async () => {
        throw new ProviderSyncRetryableFailureError();
      },
    });
    await processor.process('raw1');
    expect(updates.at(-1)).toMatchObject({ processingStatus: 'DEAD_LETTERED' });
  });
});
