import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../../metrics/metrics.service';
import { InventoryLockService } from './inventory-lock.service';
import { RedisLockStore, type RawLock } from './redis-lock.store';
import type { InventoryLockReconciliationService } from './inventory-lock-reconciliation.service';
import {
  InventoryLockCapacityExceededError,
  InventoryLockConflictError,
  InventoryLockExpiredError,
  InventoryLockIdempotencyConflictError,
  InventoryLockOwnershipMismatchError,
  InventoryLockRedisUnavailableError,
  InventoryLockRenewalRejectedError,
  InventoryLockTokenStaleError,
  InventoryLockValidationError,
} from './inventory-lock.errors';

const CFG: Record<string, unknown> = {
  INVENTORY_LOCK_TTL_SECONDS: 300,
  INVENTORY_LOCK_RENEWAL_WINDOW_SECONDS: 120,
  INVENTORY_LOCK_MAX_LIFETIME_SECONDS: 900,
  INVENTORY_LOCK_MAX_SEATS: 10,
  INVENTORY_LOCK_MAX_QUANTITY: 20,
  INVENTORY_LOCK_MAX_ACTIVE_PER_OWNER: 20,
  APP_ENV: 'TEST',
};

function rawLock(over: Partial<RawLock> = {}): RawLock {
  const now = Date.now();
  return {
    lockId: 'lock-1',
    holdId: 'hold-1',
    inventoryType: 'SEAT',
    inventoryKey: 'session:s1',
    inventoryUnitIds: ['A1'],
    ownerId: 'user-1',
    status: 'ACTIVE',
    fencingToken: 5,
    ttlSeconds: 300,
    acquiredAtMs: now - 1000,
    expiresAtMs: now + 60_000, // 60s remaining (< 120s window → renewable)
    fingerprint: 'fp',
    ...over,
  };
}

function make(storeOver: Partial<jest.Mocked<RedisLockStore>> = {}) {
  const store = {
    acquireSeat: jest.fn(),
    acquireQuantity: jest.fn(),
    renew: jest.fn(),
    release: jest.fn().mockResolvedValue(undefined),
    getRaw: jest.fn(),
    ownerActiveCount: jest.fn().mockResolvedValue(0),
    ownerTrack: jest.fn().mockResolvedValue(undefined),
    ownerUntrack: jest.fn().mockResolvedValue(undefined),
    ...storeOver,
  } as unknown as RedisLockStore;
  const config = {
    get: jest.fn((k: string, d?: unknown) => CFG[k] ?? d),
  } as unknown as ConfigService;
  const reconciliation = { reconcile: jest.fn() } as unknown as InventoryLockReconciliationService;
  const service = new InventoryLockService(store, config, new MetricsService(), reconciliation);
  return { service, store };
}

const seatReq = {
  holdId: 'hold-1',
  inventoryType: 'SEAT' as const,
  inventoryKey: 'session:s1',
  seatIds: ['A1', 'A2'],
  owner: { ownerId: 'user-1' },
  idempotencyKey: 'idem-1',
};

describe('InventoryLockService.acquire (seat)', () => {
  it('returns the lock on ACQUIRED and tracks the owner', async () => {
    const { service, store } = make();
    (store.acquireSeat as jest.Mock).mockResolvedValue({
      status: 'ACQUIRED',
      lock: rawLock({ inventoryUnitIds: ['A1', 'A2'] }),
    });
    const res = await service.acquire(seatReq);
    expect(res.replayed).toBe(false);
    expect(res.lock.fencingToken).toBe(5);
    expect(res.lock.inventoryUnitIds).toEqual(['A1', 'A2']);
    expect(store.ownerTrack).toHaveBeenCalled();
  });

  it('flags a replay (idempotent repeat)', async () => {
    const { service, store } = make();
    (store.acquireSeat as jest.Mock).mockResolvedValue({ status: 'REPLAY', lock: rawLock() });
    const res = await service.acquire(seatReq);
    expect(res.replayed).toBe(true);
    expect(store.ownerTrack).not.toHaveBeenCalled(); // replay doesn't re-track
  });

  it('throws Conflict when a seat is held by another owner', async () => {
    const { service, store } = make();
    (store.acquireSeat as jest.Mock).mockResolvedValue({ status: 'CONFLICT', conflictKey: 'x' });
    await expect(service.acquire(seatReq)).rejects.toBeInstanceOf(InventoryLockConflictError);
  });

  it('throws IdempotencyConflict when the key is reused with different details', async () => {
    const { service, store } = make();
    (store.acquireSeat as jest.Mock).mockResolvedValue({ status: 'IDEMPOTENCY_CONFLICT' });
    await expect(service.acquire(seatReq)).rejects.toBeInstanceOf(
      InventoryLockIdempotencyConflictError,
    );
  });

  it('rejects too many seats / zero seats / bad scope (validation)', async () => {
    const { service } = make();
    await expect(
      service.acquire({ ...seatReq, seatIds: Array(11).fill('S') }),
    ).rejects.toBeInstanceOf(InventoryLockValidationError);
    await expect(service.acquire({ ...seatReq, seatIds: [] })).rejects.toBeInstanceOf(
      InventoryLockValidationError,
    );
    await expect(service.acquire({ ...seatReq, inventoryKey: 'bad key!' })).rejects.toBeInstanceOf(
      InventoryLockValidationError,
    );
  });

  it('enforces the per-owner active-lock limit', async () => {
    const { service } = make({ ownerActiveCount: jest.fn().mockResolvedValue(20) } as never);
    await expect(service.acquire(seatReq)).rejects.toBeInstanceOf(InventoryLockValidationError);
  });

  it('maps a Redis transport failure to RedisUnavailable', async () => {
    const { service } = make({
      acquireSeat: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    } as never);
    await expect(service.acquire(seatReq)).rejects.toBeInstanceOf(
      InventoryLockRedisUnavailableError,
    );
  });
});

describe('InventoryLockService.acquire (quantity)', () => {
  const qtyReq = {
    holdId: 'h',
    inventoryType: 'QUANTITY' as const,
    inventoryKey: 'session:s1',
    quantity: 3,
    capacity: 10,
    owner: { ownerId: 'u' },
    idempotencyKey: 'q1',
  };
  it('throws CapacityExceeded on CAPACITY', async () => {
    const { service, store } = make();
    (store.acquireQuantity as jest.Mock).mockResolvedValue({ status: 'CAPACITY', held: 9 });
    await expect(service.acquire(qtyReq)).rejects.toBeInstanceOf(
      InventoryLockCapacityExceededError,
    );
  });
  it('rejects quantity over the max', async () => {
    const { service } = make();
    await expect(service.acquire({ ...qtyReq, quantity: 21 })).rejects.toBeInstanceOf(
      InventoryLockValidationError,
    );
  });
});

describe('InventoryLockService.renew', () => {
  const renewReq = { lockId: 'lock-1', fencingToken: 5, owner: { ownerId: 'user-1' } };
  it('renews an active, in-window, within-lifetime lock', async () => {
    const { service, store } = make({ getRaw: jest.fn().mockResolvedValue(rawLock()) } as never);
    (store.renew as jest.Mock).mockResolvedValue({
      status: 'RENEWED',
      lock: rawLock({ fencingToken: 5 }),
    });
    const res = await service.renew(renewReq);
    expect(res.lock.lockId).toBe('lock-1');
  });
  it('rejects expired (missing) lock', async () => {
    const { service } = make({ getRaw: jest.fn().mockResolvedValue(null) } as never);
    await expect(service.renew(renewReq)).rejects.toBeInstanceOf(InventoryLockExpiredError);
  });
  it('rejects a stale fencing token', async () => {
    const { service } = make({
      getRaw: jest.fn().mockResolvedValue(rawLock({ fencingToken: 9 })),
    } as never);
    await expect(service.renew(renewReq)).rejects.toBeInstanceOf(InventoryLockTokenStaleError);
  });
  it('rejects a different owner', async () => {
    const { service } = make({
      getRaw: jest.fn().mockResolvedValue(rawLock({ ownerId: 'someone-else' })),
    } as never);
    await expect(service.renew(renewReq)).rejects.toBeInstanceOf(
      InventoryLockOwnershipMismatchError,
    );
  });
  it('rejects renewal past the maximum lifetime', async () => {
    const old = rawLock({ acquiredAtMs: Date.now() - 1_000_000 }); // > 900s ago
    const { service } = make({ getRaw: jest.fn().mockResolvedValue(old) } as never);
    await expect(service.renew(renewReq)).rejects.toBeInstanceOf(InventoryLockRenewalRejectedError);
  });
  it('rejects renewal that is too early (outside the renewal window)', async () => {
    const fresh = rawLock({ expiresAtMs: Date.now() + 280_000 }); // 280s left > 120s window
    const { service } = make({ getRaw: jest.fn().mockResolvedValue(fresh) } as never);
    await expect(service.renew(renewReq)).rejects.toBeInstanceOf(InventoryLockRenewalRejectedError);
  });
});

describe('InventoryLockService.release / validate', () => {
  it('release is a no-op when the lock is already gone (idempotent)', async () => {
    const { service, store } = make({ getRaw: jest.fn().mockResolvedValue(null) } as never);
    await expect(
      service.release({ lockId: 'lock-1', owner: { ownerId: 'user-1' } }),
    ).resolves.toBeUndefined();
    expect(store.release).not.toHaveBeenCalled();
  });
  it('release rejects a different owner', async () => {
    const { service } = make({
      getRaw: jest.fn().mockResolvedValue(rawLock({ ownerId: 'other' })),
    } as never);
    await expect(
      service.release({ lockId: 'lock-1', owner: { ownerId: 'user-1' } }),
    ).rejects.toBeInstanceOf(InventoryLockOwnershipMismatchError);
  });
  it('release succeeds and is safe to call again', async () => {
    const { service, store } = make({ getRaw: jest.fn().mockResolvedValue(rawLock()) } as never);
    await service.release({ lockId: 'lock-1', owner: { ownerId: 'user-1' } });
    expect(store.release).toHaveBeenCalledWith(
      expect.objectContaining({ lockId: 'lock-1' }),
      'RELEASED',
    );
  });
  it('validate reports token_stale / owner_mismatch / valid', async () => {
    const { service } = make({ getRaw: jest.fn().mockResolvedValue(rawLock()) } as never);
    expect((await service.validate({ lockId: 'lock-1', fencingToken: 99 })).reason).toBe(
      'token_stale',
    );
    expect(
      (await service.validate({ lockId: 'lock-1', fencingToken: 5, owner: { ownerId: 'nope' } }))
        .reason,
    ).toBe('owner_mismatch');
    expect(
      (await service.validate({ lockId: 'lock-1', fencingToken: 5, owner: { ownerId: 'user-1' } }))
        .valid,
    ).toBe(true);
  });
  it('internal owner bypasses ownership checks (privileged path)', async () => {
    const { service, store } = make({
      getRaw: jest.fn().mockResolvedValue(rawLock({ ownerId: 'other' })),
    } as never);
    await service.release({ lockId: 'lock-1', owner: { internal: true } });
    expect(store.release).toHaveBeenCalled();
  });
});
