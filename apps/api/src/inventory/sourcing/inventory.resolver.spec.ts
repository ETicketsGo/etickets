import { ExperienceType } from '@eticketsgo/shared-types';
import { AppException } from '../../common/errors';
import { InventoryProviderRegistry } from './inventory-provider.registry';
import { InventoryResolver, type ResolveContext } from './inventory.resolver';
import { ProviderHealthMonitor } from './provider-health.monitor';
import { ProviderPriorityManager } from './provider-priority.manager';
import type { InventoryProvider } from './inventory-provider.interface';

const CTX: ResolveContext = {
  experienceType: ExperienceType.MOVIE,
  eventSessionId: 'sess_1',
};

/** A stub provider whose ops/health are controllable per test. */
function stub(
  name: string,
  opts: { failover: boolean; healthy?: boolean; op?: () => Promise<unknown> },
): InventoryProvider {
  return {
    name,
    sourceKind: 'DIRECT',
    capabilities: { search: false, authority: 'LOCAL', failover: opts.failover },
    search: jest.fn(),
    availability: jest.fn(),
    lockInventory: jest.fn(),
    confirmBooking: jest.fn(),
    cancelBooking: jest.fn(),
    refund: jest.fn(),
    sync: jest.fn(),
    health: jest.fn().mockResolvedValue({ healthy: opts.healthy ?? true, checkedAt: new Date() }),
  } as unknown as InventoryProvider;
}

function make(providers: InventoryProvider[], order?: string[]) {
  const registry = new InventoryProviderRegistry();
  providers.forEach((p) => registry.register(p));
  const priority = {
    order: jest.fn().mockReturnValue(order ?? providers.map((p) => p.name)),
  } as unknown as ProviderPriorityManager;
  const health = new ProviderHealthMonitor(registry);
  const resolver = new InventoryResolver(priority, health, registry);
  return { resolver, registry, health };
}

describe('InventoryResolver', () => {
  it('resolves the first HEALTHY provider in priority order', async () => {
    const down = stub('aggregator', { failover: true, healthy: false });
    const up = stub('direct', { failover: false, healthy: true });
    const { resolver } = make([down, up], ['aggregator', 'direct']);

    const chosen = await resolver.resolve(CTX);
    expect(chosen.name).toBe('direct'); // unhealthy aggregator skipped
  });

  it('throws INVENTORY_PROVIDER_UNAVAILABLE when no provider is healthy', async () => {
    const down = stub('direct', { failover: false, healthy: false });
    const { resolver } = make([down]);
    await expect(resolver.resolve(CTX)).rejects.toBeInstanceOf(AppException);
  });

  it('honours a trusted preferredProvider pin by trying it first', async () => {
    const a = stub('direct', { failover: false, healthy: true });
    const b = stub('manual', { failover: false, healthy: true });
    const { resolver } = make([a, b], ['direct', 'manual']);

    const chosen = await resolver.resolve({ ...CTX, preferredProvider: 'manual' });
    expect(chosen.name).toBe('manual');
  });

  describe('withFailover', () => {
    it('fails over to the next candidate when a FAILOVER-eligible provider throws', async () => {
      const remote = stub('aggregator', { failover: true, healthy: true });
      const local = stub('direct', { failover: false, healthy: true });
      const { resolver } = make([remote, local], ['aggregator', 'direct']);

      const op = jest.fn<Promise<string>, [InventoryProvider]>().mockImplementation(async (p) => {
        if (p.name === 'aggregator') throw new Error('vendor 503');
        return 'served-by-direct';
      });

      const result = await resolver.withFailover(CTX, op);
      expect(result).toBe('served-by-direct');
      expect(op).toHaveBeenCalledTimes(2);
    });

    it('NEVER fails over off an authoritative provider (failover=false): its error surfaces', async () => {
      const local = stub('direct', { failover: false, healthy: true });
      const other = stub('manual', { failover: false, healthy: true });
      const { resolver } = make([local, other], ['direct', 'manual']);

      const soldOut = new Error('sold out');
      const op = jest.fn().mockRejectedValue(soldOut);

      await expect(resolver.withFailover(CTX, op)).rejects.toBe(soldOut);
      expect(op).toHaveBeenCalledTimes(1); // stopped at the authoritative provider
    });

    it('rethrows the last error when every failover candidate fails', async () => {
      const a = stub('aggregator', { failover: true, healthy: true });
      const b = stub('aggregator2', { failover: true, healthy: true });
      const { resolver } = make([a, b], ['aggregator', 'aggregator2']);

      const op = jest
        .fn()
        .mockRejectedValueOnce(new Error('first'))
        .mockRejectedValueOnce(new Error('last'));

      await expect(resolver.withFailover(CTX, op)).rejects.toThrow('last');
      expect(op).toHaveBeenCalledTimes(2);
    });
  });
});
