import { ConfigService } from '@nestjs/config';
import { InventoryProviderRegistry } from './inventory-provider.registry';
import { ProviderPriorityManager } from './provider-priority.manager';
import type { InventoryProvider } from './inventory-provider.interface';

function reg(names: string[]): InventoryProviderRegistry {
  const registry = new InventoryProviderRegistry();
  names.forEach((name) =>
    registry.register({
      name,
      sourceKind: 'DIRECT',
      capabilities: {},
    } as unknown as InventoryProvider),
  );
  return registry;
}

function manager(names: string[], priority?: string): ProviderPriorityManager {
  const config = { get: jest.fn().mockReturnValue(priority) } as unknown as ConfigService;
  return new ProviderPriorityManager(config, reg(names));
}

describe('ProviderPriorityManager', () => {
  it('defaults to LOCAL-first order (direct, manual) before external', () => {
    expect(manager(['aggregator', 'manual', 'direct']).order()).toEqual([
      'direct',
      'manual',
      'aggregator',
    ]);
  });

  it('honours the configured order first', () => {
    expect(manager(['direct', 'manual', 'aggregator'], 'aggregator,direct').order()).toEqual([
      'aggregator',
      'direct',
      'manual', // not configured → appended in default order
    ]);
  });

  it('never emits a name that is not registered', () => {
    expect(manager(['direct'], 'aggregator,direct').order()).toEqual(['direct']);
  });

  it('appends registered providers absent from config and the default list (new vendors)', () => {
    const out = manager(['direct', 'vendorx']).order();
    expect(out).toContain('vendorx');
    expect(out[0]).toBe('direct'); // local still preferred
  });
});
