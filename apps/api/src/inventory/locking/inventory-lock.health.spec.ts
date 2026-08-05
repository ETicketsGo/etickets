import { ConfigService } from '@nestjs/config';
import { InventoryLockHealthService } from './inventory-lock.health';
import { RedisLockStore } from './redis-lock.store';

function make(cfg: Record<string, unknown>, redisReachable: boolean) {
  const store = {
    isHealthy: jest.fn().mockResolvedValue(redisReachable),
  } as unknown as RedisLockStore;
  const config = {
    get: jest.fn((k: string, d?: unknown) => cfg[k] ?? d),
  } as unknown as ConfigService;
  return { service: new InventoryLockHealthService(config, store), store };
}

describe('InventoryLockHealthService', () => {
  it('disabled ⇒ ready, Redis not probed', async () => {
    const { service, store } = make({ INVENTORY_LOCKS_ENABLED: false }, false);
    const h = await service.report();
    expect(h).toMatchObject({ enabled: false, ready: true, redisReachable: false });
    expect(store.isHealthy).not.toHaveBeenCalled();
  });

  it('shadow mode ⇒ ready even when Redis is down', async () => {
    const { service } = make(
      { INVENTORY_LOCKS_ENABLED: true, INVENTORY_LOCKS_MODE: 'shadow' },
      false,
    );
    expect((await service.report()).ready).toBe(true);
  });

  it('active mode ⇒ NOT ready when Redis is unreachable', async () => {
    const { service } = make(
      { INVENTORY_LOCKS_ENABLED: true, INVENTORY_LOCKS_MODE: 'active' },
      false,
    );
    const h = await service.report();
    expect(h.ready).toBe(false);
    expect(h.redisReachable).toBe(false);
  });

  it('active mode ⇒ ready when Redis is reachable', async () => {
    const { service } = make(
      { INVENTORY_LOCKS_ENABLED: true, INVENTORY_LOCKS_MODE: 'active' },
      true,
    );
    expect((await service.report()).ready).toBe(true);
  });
});
