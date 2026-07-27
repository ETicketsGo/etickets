import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../../metrics/metrics.service';
import { InventoryLockShadowService } from './inventory-lock-shadow.service';
import { InventoryLockService } from './inventory-lock.service';

function make(cfg: Record<string, unknown>, acquireImpl?: () => Promise<unknown>) {
  const locks = {
    acquire: jest.fn(
      acquireImpl ?? (async () => ({ lock: { lockId: 'l1', fencingToken: 1 }, replayed: false })),
    ),
    release: jest.fn().mockResolvedValue(undefined),
  } as unknown as InventoryLockService;
  const config = {
    get: jest.fn((k: string, d?: unknown) => cfg[k] ?? d),
  } as unknown as ConfigService;
  const service = new InventoryLockShadowService(locks, config, new MetricsService());
  return { service, locks };
}

const obs = {
  inventoryType: 'SEAT' as const,
  inventoryKey: 'session:s1',
  seatIds: ['A1'],
  holdId: 'h1',
  bookingId: 'b1',
  owner: { ownerId: 'u1' },
};

describe('InventoryLockShadowService', () => {
  it('is a no-op when the engine is disabled', async () => {
    const { service, locks } = make({
      INVENTORY_LOCKS_ENABLED: false,
      INVENTORY_LOCKS_MODE: 'shadow',
    });
    await service.observe(obs);
    expect(locks.acquire).not.toHaveBeenCalled();
  });

  it('is a no-op in active mode (P3 wires shadow only)', async () => {
    const { service, locks } = make({
      INVENTORY_LOCKS_ENABLED: true,
      INVENTORY_LOCKS_MODE: 'active',
    });
    await service.observe(obs);
    expect(locks.acquire).not.toHaveBeenCalled();
  });

  it('acquires then immediately releases when observing (never holds)', async () => {
    const { service, locks } = make({
      INVENTORY_LOCKS_ENABLED: true,
      INVENTORY_LOCKS_MODE: 'shadow',
    });
    await service.observe(obs);
    expect(locks.acquire).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'shadow:b1' }),
    );
    expect(locks.release).toHaveBeenCalled();
  });

  it('swallows a divergence (Redis conflict) without throwing', async () => {
    const { service } = make(
      { INVENTORY_LOCKS_ENABLED: true, INVENTORY_LOCKS_MODE: 'shadow' },
      async () => {
        throw new Error('conflict');
      },
    );
    await expect(service.observe(obs)).resolves.toBeUndefined();
  });
});
