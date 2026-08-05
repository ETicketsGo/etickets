import { createHash } from 'node:crypto';
import { MetricsService } from '../../metrics/metrics.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../cache/cache.service';
import type { DomainEventBus } from '../../common/domain-events';
import { SyncApplicationService } from './sync-application.service';
import { ProviderSyncOrderingConflictError } from './sync.errors';
import type {
  CanonicalInventoryChange,
  InventoryOwnershipMode,
} from './contracts/canonical-change';

const hashOf = (c: unknown) =>
  createHash('sha256').update(JSON.stringify(c)).digest('hex').slice(0, 32);

function make(mapping: Record<string, unknown> | null) {
  const tx = {
    providerMapping: {
      findUnique: jest.fn().mockResolvedValue(mapping),
      create: jest.fn().mockResolvedValue({ id: 'm1', ...mapping }),
      update: jest.fn().mockResolvedValue({}),
    },
    providerInventoryState: { upsert: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
  } as unknown as PrismaService;
  const cache = { invalidateByPattern: jest.fn().mockResolvedValue(1) } as unknown as CacheService;
  const events = {
    publishMany: jest.fn().mockResolvedValue(undefined),
    publish: jest.fn(),
    subscribe: jest.fn(),
  } as unknown as DomainEventBus;
  const service = new SyncApplicationService(prisma, new MetricsService(), cache, events);
  return { service, tx, cache, events };
}

const ctx = (mode: InventoryOwnershipMode = 'PROVIDER_AUTHORITATIVE') => ({
  providerCode: 'mock',
  providerTenantId: '',
  defaultOwnershipMode: mode,
});

const seatChange = (version: number): CanonicalInventoryChange => ({
  kind: 'UPDATE_SEAT_AVAILABILITY',
  externalEntityType: 'SEAT_AVAILABILITY',
  externalEntityId: 's1',
  externalSessionId: 's1',
  layoutVersion: 'v1',
  seats: [{ externalSeatId: 'A1', state: 'SOLD' }],
  externalVersion: version,
});

const activeMapping = (over: Record<string, unknown> = {}) => ({
  id: 'm1',
  ownershipMode: 'PROVIDER_AUTHORITATIVE',
  externalVersion: null,
  lastProviderUpdatedAt: null,
  mappingMetadata: null,
  ...over,
});

describe('SyncApplicationService — version ordering', () => {
  it('applies a newer version (v5 after v4)', async () => {
    const { service, tx } = make(activeMapping({ externalVersion: 4 }));
    const out = await service.apply(seatChange(5), ctx());
    expect(out.applied).toBe(true);
    expect(tx.providerInventoryState.upsert).toHaveBeenCalled();
  });

  it('ignores an older version (v4 cannot overwrite v5)', async () => {
    const { service, tx } = make(activeMapping({ externalVersion: 5 }));
    const out = await service.apply(seatChange(4), ctx());
    expect(out).toMatchObject({ applied: false, reason: 'stale' });
    expect(tx.providerInventoryState.upsert).not.toHaveBeenCalled();
  });

  it('ignores a duplicate version with the same payload hash', async () => {
    const change = seatChange(5);
    const { service, tx } = make(
      activeMapping({ externalVersion: 5, mappingMetadata: { lastHash: hashOf(change) } }),
    );
    const out = await service.apply(change, ctx());
    expect(out).toMatchObject({ applied: false, reason: 'stale' });
    expect(tx.providerInventoryState.upsert).not.toHaveBeenCalled();
  });

  it('escalates the same version with a DIFFERENT payload to an ordering conflict', async () => {
    const { service } = make(
      activeMapping({ externalVersion: 5, mappingMetadata: { lastHash: 'different' } }),
    );
    await expect(service.apply(seatChange(5), ctx())).rejects.toBeInstanceOf(
      ProviderSyncOrderingConflictError,
    );
  });
});

describe('SyncApplicationService — ownership modes', () => {
  it('LOCAL_AUTHORITATIVE never imports external availability', async () => {
    const { service, tx } = make(activeMapping({ ownershipMode: 'LOCAL_AUTHORITATIVE' }));
    const out = await service.apply(seatChange(1), ctx('LOCAL_AUTHORITATIVE'));
    expect(out).toMatchObject({ applied: false, reason: 'local_authoritative' });
    expect(tx.providerInventoryState.upsert).not.toHaveBeenCalled();
  });
});

describe('SyncApplicationService — cache + events after commit', () => {
  it('invalidates cache + publishes events only after a successful apply', async () => {
    const { service, cache, events } = make(activeMapping({ externalVersion: 1 }));
    await service.apply(seatChange(2), ctx());
    expect(cache.invalidateByPattern).toHaveBeenCalled();
    expect(events.publishMany).toHaveBeenCalledTimes(1);
  });

  it('does not invalidate cache for a stale (ignored) change', async () => {
    const { service, cache } = make(activeMapping({ externalVersion: 9 }));
    await service.apply(seatChange(2), ctx());
    expect(cache.invalidateByPattern).not.toHaveBeenCalled();
  });
});
