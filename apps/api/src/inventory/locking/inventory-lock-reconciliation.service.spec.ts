import { BookingStatus } from '@eticketsgo/shared-types';
import { MetricsService } from '../../metrics/metrics.service';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryLockReconciliationService } from './inventory-lock-reconciliation.service';
import { RedisLockStore, type RawLock } from './redis-lock.store';

function raw(over: Partial<RawLock> = {}): RawLock {
  return {
    lockId: 'l1',
    holdId: 'h1',
    bookingId: 'b1',
    inventoryType: 'SEAT',
    inventoryKey: 'session:s1',
    status: 'ACTIVE',
    fencingToken: 1,
    ttlSeconds: 300,
    acquiredAtMs: Date.now(),
    expiresAtMs: Date.now() + 1000,
    fingerprint: 'fp',
    ...over,
  };
}

function make(locks: RawLock[], bookingStatus: string | null) {
  const store = {
    scanRawLocks: jest.fn().mockResolvedValue(locks),
    release: jest.fn().mockResolvedValue(undefined),
  } as unknown as RedisLockStore;
  const prisma = {
    booking: {
      findUnique: jest.fn().mockResolvedValue(bookingStatus ? { status: bookingStatus } : null),
    },
  } as unknown as PrismaService;
  const service = new InventoryLockReconciliationService(store, prisma, new MetricsService());
  return { service, store };
}

describe('InventoryLockReconciliationService', () => {
  it('classifies an active Redis lock whose booking expired as stale + repairs it', async () => {
    const { service, store } = make([raw()], BookingStatus.EXPIRED);
    const res = await service.reconcile({ repair: true });
    expect(res.mismatches[0].kind).toBe('DB_HOLD_EXPIRED_REDIS_SURVIVING');
    expect(res.repaired).toBe(1);
    expect(store.release).toHaveBeenCalledWith(expect.anything(), 'EXPIRED');
  });

  it('classifies an active Redis lock with NO booking as orphaned', async () => {
    const { service } = make([raw()], null);
    const res = await service.reconcile({});
    expect(res.mismatches[0].kind).toBe('REDIS_LOCK_WITHOUT_DB_HOLD');
    expect(res.repaired).toBe(0); // repair not requested
  });

  it('marks a confirmed booking whose Redis lock is still active', async () => {
    const { service, store } = make([raw()], BookingStatus.CONFIRMED);
    const res = await service.reconcile({ repair: true });
    expect(res.mismatches[0].kind).toBe('DB_CONFIRMED_REDIS_STILL_ACTIVE');
    expect(store.release).toHaveBeenCalledWith(expect.anything(), 'CONFIRMED');
  });

  it('flags Redis-confirmed-but-DB-not-confirmed for MANUAL review (never auto-repairs)', async () => {
    const { service, store } = make([raw({ status: 'CONFIRMED' })], BookingStatus.PENDING_PAYMENT);
    const res = await service.reconcile({ repair: true });
    expect(res.mismatches[0].kind).toBe('REDIS_CONFIRMED_DB_NOT_CONFIRMED');
    expect(res.manualReviewRequired).toBe(1);
    expect(res.repaired).toBe(0);
    expect(store.release).not.toHaveBeenCalled();
  });

  it('reports no mismatch for a consistent active hold', async () => {
    const { service } = make([raw()], BookingStatus.PENDING_PAYMENT);
    const res = await service.reconcile({});
    expect(res.mismatches).toHaveLength(0);
  });
});
