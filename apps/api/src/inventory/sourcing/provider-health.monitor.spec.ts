import { InventoryProviderRegistry } from './inventory-provider.registry';
import { ProviderHealthMonitor } from './provider-health.monitor';
import type { InventoryProvider, ProviderHealth } from './inventory-provider.interface';

function providerWithHealth(
  name: string,
  health: () => Promise<ProviderHealth>,
): InventoryProvider {
  return { name, sourceKind: 'DIRECT', capabilities: {}, health } as unknown as InventoryProvider;
}

describe('ProviderHealthMonitor', () => {
  it('caches a health result within the TTL (single probe)', async () => {
    const probe = jest.fn().mockResolvedValue({ healthy: true, checkedAt: new Date() });
    const registry = new InventoryProviderRegistry();
    const provider = providerWithHealth('direct', probe);
    registry.register(provider);
    const monitor = new ProviderHealthMonitor(registry);

    await monitor.check(provider, 1_000);
    await monitor.check(provider, 5_000); // within 10s TTL
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('re-probes after the TTL expires', async () => {
    const probe = jest.fn().mockResolvedValue({ healthy: true, checkedAt: new Date() });
    const registry = new InventoryProviderRegistry();
    const provider = providerWithHealth('direct', probe);
    registry.register(provider);
    const monitor = new ProviderHealthMonitor(registry);

    await monitor.check(provider, 1_000);
    await monitor.check(provider, 20_000); // past 10s TTL
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('treats a throwing probe as unhealthy (never propagates)', async () => {
    const registry = new InventoryProviderRegistry();
    const provider = providerWithHealth(
      'aggregator',
      jest.fn().mockRejectedValue(new Error('boom')),
    );
    registry.register(provider);
    const monitor = new ProviderHealthMonitor(registry);

    const health = await monitor.check(provider, 1_000);
    expect(health.healthy).toBe(false);
  });

  it('isHealthy is false for an unregistered provider', async () => {
    const monitor = new ProviderHealthMonitor(new InventoryProviderRegistry());
    expect(await monitor.isHealthy('ghost')).toBe(false);
  });

  it('invalidate forces a fresh probe', async () => {
    const probe = jest.fn().mockResolvedValue({ healthy: true, checkedAt: new Date() });
    const registry = new InventoryProviderRegistry();
    const provider = providerWithHealth('direct', probe);
    registry.register(provider);
    const monitor = new ProviderHealthMonitor(registry);

    await monitor.check(provider, 1_000);
    monitor.invalidate('direct');
    await monitor.check(provider, 2_000);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
