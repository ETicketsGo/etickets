import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../../metrics/metrics.service';
import { SyncPollingService } from './sync-polling.service';
import { InventorySyncProviderRegistry } from './sync-provider.registry';
import { SyncCheckpointService } from './sync-checkpoint.service';
import { SyncIngestionService } from './sync-ingestion.service';

function make(opts: { enabled?: boolean; lease?: boolean; supportsPolling?: boolean } = {}) {
  const provider = {
    providerCode: 'mock-aggregator',
    supportsPolling: opts.supportsPolling ?? true,
    fetchChanges: jest.fn().mockResolvedValueOnce({
      records: [{ externalEventId: 'e1', eventType: 'x', record: {} }],
      nextCursor: 'p1',
      hasMore: false,
    }),
  };
  const registry = {
    get: jest.fn().mockReturnValue(provider),
    list: jest.fn().mockReturnValue([provider]),
  } as unknown as InventorySyncProviderRegistry;
  const checkpoints = {
    acquireLease: jest.fn().mockResolvedValue(opts.lease ?? true),
    get: jest.fn().mockResolvedValue({ cursor: null }),
    advance: jest.fn().mockResolvedValue(undefined),
    recordFailure: jest.fn().mockResolvedValue(undefined),
    releaseLease: jest.fn().mockResolvedValue(undefined),
  } as unknown as SyncCheckpointService;
  const ingestion = {
    acceptEvent: jest.fn().mockResolvedValue({ accepted: true, duplicate: false }),
  } as unknown as SyncIngestionService;
  const config = {
    get: jest.fn((k: string, d?: unknown) =>
      opts.enabled === false && k.includes('ENABLED')
        ? false
        : k.includes('ENABLED')
          ? true
          : (d ?? 300),
    ),
  } as unknown as ConfigService;
  const service = new SyncPollingService(
    registry,
    checkpoints,
    ingestion,
    config,
    new MetricsService(),
  );
  return { service, checkpoints, ingestion, provider };
}

describe('SyncPollingService.poll', () => {
  it('no-ops when polling is disabled', async () => {
    const { service, checkpoints } = make({ enabled: false });
    expect(await service.poll('mock-aggregator')).toBe(0);
    expect(checkpoints.acquireLease).not.toHaveBeenCalled();
  });

  it('skips when the lease is held by another node', async () => {
    const { service, ingestion } = make({ lease: false });
    expect(await service.poll('mock-aggregator')).toBe(0);
    expect(ingestion.acceptEvent).not.toHaveBeenCalled();
  });

  it('persists every record then advances the checkpoint (cursor only after acceptance)', async () => {
    const { service, ingestion, checkpoints } = make({ lease: true });
    const accepted = await service.poll('mock-aggregator');
    expect(accepted).toBe(1);
    expect(ingestion.acceptEvent).toHaveBeenCalledTimes(1);
    const advanceOrder = (checkpoints.advance as jest.Mock).mock.invocationCallOrder[0];
    const acceptOrder = (ingestion.acceptEvent as jest.Mock).mock.invocationCallOrder[0];
    expect(advanceOrder).toBeGreaterThan(acceptOrder); // advanced AFTER persistence
    expect(checkpoints.releaseLease).toHaveBeenCalled();
  });

  it('does not poll a provider that does not support polling', async () => {
    const { service, checkpoints } = make({ supportsPolling: false });
    expect(await service.poll('mock-aggregator')).toBe(0);
    expect(checkpoints.acquireLease).not.toHaveBeenCalled();
  });
});
