import { MetricsService } from '../../metrics/metrics.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { DomainEventBus } from '../../common/domain-events';
import { ProviderSyncHealthService } from './sync-health.service';
import { InventorySyncProviderRegistry } from './sync-provider.registry';

function make(counts: { backlog: number; dead: number; manual: number }, adapterState = 'HEALTHY') {
  const prisma = {
    rawProviderEvent: {
      count: jest
        .fn()
        .mockResolvedValueOnce(counts.backlog)
        .mockResolvedValueOnce(counts.dead)
        .mockResolvedValueOnce(counts.manual),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  } as unknown as PrismaService;
  const provider = {
    providerCode: 'mock',
    health: jest.fn().mockResolvedValue({ state: adapterState }),
  };
  const registry = {
    get: jest.fn().mockReturnValue(provider),
  } as unknown as InventorySyncProviderRegistry;
  const events = { publish: jest.fn().mockResolvedValue(undefined) } as unknown as DomainEventBus;
  return {
    service: new ProviderSyncHealthService(prisma, registry, new MetricsService(), events),
    events,
  };
}

describe('ProviderSyncHealthService', () => {
  it('reports HEALTHY with no backlog/dead-letters and emits a transition event once', async () => {
    const { service, events } = make({ backlog: 0, dead: 0, manual: 0 });
    const r = await service.report('mock');
    expect(r.state).toBe('HEALTHY');
    expect(events.publish).toHaveBeenCalledTimes(1); // UNKNOWN → HEALTHY transition
  });

  it('reports UNHEALTHY when dead-letters exist', async () => {
    const { service } = make({ backlog: 0, dead: 3, manual: 0 });
    expect((await service.report('mock')).state).toBe('UNHEALTHY');
  });

  it('reports DEGRADED on a large backlog', async () => {
    const { service } = make({ backlog: 5000, dead: 0, manual: 0 });
    expect((await service.report('mock')).state).toBe('DEGRADED');
  });
});
