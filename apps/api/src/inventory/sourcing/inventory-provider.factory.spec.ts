import { ConfigService } from '@nestjs/config';
import { AppException } from '../../common/errors';
import { InventoryProviderFactory } from './inventory-provider.factory';
import { InventoryProviderRegistry } from './inventory-provider.registry';
import type { InventoryProvider } from './inventory-provider.interface';

const direct = { name: 'direct', sourceKind: 'DIRECT' } as unknown as InventoryProvider;
const manual = { name: 'manual', sourceKind: 'MANUAL' } as unknown as InventoryProvider;
const aggregator = { name: 'aggregator', sourceKind: 'AGGREGATOR' } as unknown as InventoryProvider;

function make(aggregatorEnabled: boolean) {
  const registry = new InventoryProviderRegistry();
  const config = {
    get: jest.fn((key: string) =>
      key === 'INVENTORY_AGGREGATOR_ENABLED' ? aggregatorEnabled : undefined,
    ),
  } as unknown as ConfigService;
  const factory = new InventoryProviderFactory(
    config,
    registry,
    direct as never,
    manual as never,
    aggregator as never,
  );
  return { factory, registry };
}

describe('InventoryProviderFactory', () => {
  it('always registers the LOCAL providers (direct, manual)', () => {
    const { factory, registry } = make(false);
    factory.registerAll();
    expect(registry.has('direct')).toBe(true);
    expect(registry.has('manual')).toBe(true);
  });

  it('does NOT register the aggregator placeholder while the flag is off', () => {
    const { factory, registry } = make(false);
    factory.registerAll();
    expect(registry.has('aggregator')).toBe(false);
  });

  it('registers the aggregator only when INVENTORY_AGGREGATOR_ENABLED is set', () => {
    const { factory, registry } = make(true);
    factory.registerAll();
    expect(registry.has('aggregator')).toBe(true);
  });

  it('get() throws a clear error for an unknown provider name', () => {
    const { factory } = make(false);
    factory.registerAll();
    expect(() => factory.get('nope')).toThrow(AppException);
  });
});
