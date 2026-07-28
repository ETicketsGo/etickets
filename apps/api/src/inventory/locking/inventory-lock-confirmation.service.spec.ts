import { MetricsService } from '../../metrics/metrics.service';
import { InventoryLockConfirmationService } from './inventory-lock-confirmation.service';
import { InventoryLockConfirmationFailedError } from './inventory-lock.errors';
import { InventoryLockService } from './inventory-lock.service';
import type { RawLock } from './redis-lock.store';

function make(over: Partial<Record<string, unknown>> = {}) {
  const raw = { lockId: 'l1', inventoryType: 'SEAT', inventoryKey: 'session:s1' } as RawLock;
  const locks = {
    getRaw: jest.fn().mockResolvedValue(raw),
    validate: jest.fn().mockResolvedValue({ valid: true, lock: {} }),
    markInternal: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    ...over,
  } as unknown as InventoryLockService;
  const events = { publishMany: jest.fn().mockResolvedValue(undefined) };
  const service = new InventoryLockConfirmationService(
    locks,
    new MetricsService(),
    events as never,
  );
  return { service, locks, events };
}

const req = { lockId: 'l1', fencingToken: 1, owner: { ownerId: 'u1' } };

describe('InventoryLockConfirmationService', () => {
  it('runs the PostgreSQL work, then marks Redis CONFIRMED, then publishes events', async () => {
    const order: string[] = [];
    const { service, locks, events } = make({
      markInternal: jest.fn(async () => void order.push('redis')),
    });
    const result = await service.confirm(req, async () => {
      order.push('db');
      return 'committed';
    }, [{ eventId: 'e1' } as never]);
    expect(result.work).toBe('committed');
    expect(order).toEqual(['db', 'redis']); // Redis only marked AFTER the DB work
    expect(locks.markInternal).toHaveBeenCalledWith(expect.anything(), 'CONFIRMED');
    expect(events.publishMany).toHaveBeenCalledTimes(1);
    expect(result.reconciliationRequired).toBe(false);
  });

  it('does NOT mark Redis confirmed when the PostgreSQL work fails (retry-safe)', async () => {
    const { service, locks } = make();
    await expect(
      service.confirm(req, async () => {
        throw new Error('db down');
      }),
    ).rejects.toBeInstanceOf(InventoryLockConfirmationFailedError);
    expect(locks.markInternal).not.toHaveBeenCalled();
  });

  it('keeps the commit and flags reconciliation when Redis cleanup fails post-commit', async () => {
    const { service } = make({
      markInternal: jest.fn().mockRejectedValue(new Error('redis down')),
    });
    const result = await service.confirm(req, async () => 'committed');
    expect(result.work).toBe('committed'); // commit stands
    expect(result.reconciliationRequired).toBe(true);
  });

  it('fails confirmation when the lock is invalid (stale token / owner mismatch)', async () => {
    const { service } = make({
      validate: jest.fn().mockResolvedValue({ valid: false, reason: 'token_stale' }),
    });
    await expect(service.confirm(req, async () => 'x')).rejects.toBeInstanceOf(
      InventoryLockConfirmationFailedError,
    );
  });

  it('fails confirmation when the lock is gone', async () => {
    const { service } = make({ getRaw: jest.fn().mockResolvedValue(null) });
    await expect(service.confirm(req, async () => 'x')).rejects.toBeInstanceOf(
      InventoryLockConfirmationFailedError,
    );
  });
});
