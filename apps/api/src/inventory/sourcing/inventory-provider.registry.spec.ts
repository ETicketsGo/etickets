import { InventoryProviderRegistry } from './inventory-provider.registry';
import type { InventoryProvider } from './inventory-provider.interface';

const p = (name: string): InventoryProvider =>
  ({ name, sourceKind: 'DIRECT', capabilities: {} }) as unknown as InventoryProvider;

describe('InventoryProviderRegistry', () => {
  it('registers and resolves case-insensitively', () => {
    const r = new InventoryProviderRegistry();
    r.register(p('Direct'));
    expect(r.get('direct')?.name).toBe('Direct');
    expect(r.has('DIRECT')).toBe(true);
  });

  it('list() dedupes and names() reflects registration', () => {
    const r = new InventoryProviderRegistry();
    r.register(p('direct'));
    r.register(p('manual'));
    expect(r.list()).toHaveLength(2);
    expect(r.names()).toEqual(['direct', 'manual']);
  });

  it('re-registering the same name replaces the adapter', () => {
    const r = new InventoryProviderRegistry();
    const first = p('direct');
    const second = p('direct');
    r.register(first);
    r.register(second);
    expect(r.get('direct')).toBe(second);
    expect(r.list()).toHaveLength(1);
  });

  it('returns undefined for an unknown name', () => {
    expect(new InventoryProviderRegistry().get('ghost')).toBeUndefined();
  });
});
