import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisLockStore } from './redis-lock.store';

export interface InventoryLockHealth {
  enabled: boolean;
  mode: 'shadow' | 'active';
  reconciliationEnabled: boolean;
  redisReachable: boolean;
  /**
   * Readiness for endpoints that REQUIRE distributed locking. In active mode this is
   * false when Redis is unreachable (so lock traffic is not routed to an unhealthy
   * node); disabled/shadow are always ready (they never depend on Redis for
   * correctness). Read-only APIs are unaffected.
   */
  ready: boolean;
}

/**
 * Health/readiness reporter for the lock engine (ADR-039). Distinguishes disabled /
 * shadow / active and whether Redis is reachable, without marking unrelated read-only
 * APIs unhealthy.
 */
@Injectable()
export class InventoryLockHealthService {
  constructor(
    private readonly config: ConfigService,
    private readonly store: RedisLockStore,
  ) {}

  async report(): Promise<InventoryLockHealth> {
    const enabled = this.config.get<boolean>('INVENTORY_LOCKS_ENABLED') === true;
    const mode = this.config.get<'shadow' | 'active'>('INVENTORY_LOCKS_MODE', 'shadow');
    const reconciliationEnabled =
      this.config.get<boolean>('INVENTORY_LOCK_RECONCILIATION_ENABLED') === true;
    const redisReachable = enabled ? await this.store.isHealthy().catch(() => false) : false;
    const ready = !enabled || mode === 'shadow' ? true : redisReachable;
    return { enabled, mode, reconciliationEnabled, redisReachable, ready };
  }
}
