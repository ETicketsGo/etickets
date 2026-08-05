import { ConfigService } from '@nestjs/config';
import { InventorySyncProviderRegistry } from './sync-provider.registry';
import { UnknownInventorySyncProviderError } from './sync.errors';
import type { InventorySyncProvider } from './contracts/sync-provider.interface';

const stub = (code: string): InventorySyncProvider =>
  ({
    providerCode: code,
    ownershipMode: 'PROVIDER_AUTHORITATIVE',
    supportsWebhooks: true,
    supportsPolling: true,
  }) as never;

function make(allowlist: string) {
  const config = { get: jest.fn(() => allowlist) } as unknown as ConfigService;
  const reg = new InventorySyncProviderRegistry(config);
  return reg;
}

describe('InventorySyncProviderRegistry', () => {
  it('resolves a registered + allowlisted provider', () => {
    const reg = make('mock-aggregator');
    reg.register(stub('mock-aggregator'));
    expect(reg.resolve('mock-aggregator').providerCode).toBe('mock-aggregator');
  });

  it('fails safe (unknown) for a registered provider NOT on the allowlist', () => {
    const reg = make('');
    reg.register(stub('mock-aggregator'));
    expect(() => reg.resolve('mock-aggregator')).toThrow(UnknownInventorySyncProviderError);
  });

  it('rejects a provider-code with path/injection characters', () => {
    const reg = make('../../etc');
    expect(() => reg.resolve('../../etc/passwd')).toThrow(UnknownInventorySyncProviderError);
  });

  it('get() bypasses the allowlist for internal processing', () => {
    const reg = make('');
    reg.register(stub('mock-aggregator'));
    expect(reg.get('mock-aggregator')?.providerCode).toBe('mock-aggregator');
    expect(reg.get('nope')).toBeUndefined();
  });
});
