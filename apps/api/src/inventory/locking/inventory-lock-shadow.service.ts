import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../../metrics/metrics.service';
import { InventoryLockService } from './inventory-lock.service';
import { safeScopeId } from './inventory-lock.keys';
import type { InventoryType, LockOwner } from './inventory-lock.types';

export interface ShadowObservation {
  inventoryType: InventoryType;
  inventoryKey: string;
  seatIds?: string[];
  quantity?: number;
  capacity?: number;
  holdId: string;
  bookingId: string;
  owner: LockOwner;
  correlationId?: string;
}

/**
 * SHADOW-mode observation of the distributed lock engine (ADR-039, Option A). Called
 * AFTER the authoritative PostgreSQL hold has already succeeded, it attempts a Redis
 * lock purely to MEASURE what the distributed layer would have decided, then releases
 * it immediately. It changes NO booking behaviour: every failure is swallowed and
 * recorded as a metric. It publishes NO domain events (shadow activity is not an
 * authoritative fact). A no-op unless INVENTORY_LOCKS_ENABLED and mode=shadow.
 */
@Injectable()
export class InventoryLockShadowService {
  private readonly logger = new Logger('InventoryLockShadow');

  constructor(
    private readonly locks: InventoryLockService,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
  ) {}

  private get active(): boolean {
    return (
      this.config.get<boolean>('INVENTORY_LOCKS_ENABLED') === true &&
      this.config.get<string>('INVENTORY_LOCKS_MODE', 'shadow') === 'shadow'
    );
  }

  async observe(obs: ShadowObservation): Promise<void> {
    if (!this.active) return;
    try {
      const result = await this.locks.acquire({
        holdId: obs.holdId,
        inventoryType: obs.inventoryType,
        inventoryKey: obs.inventoryKey,
        seatIds: obs.seatIds,
        quantity: obs.quantity,
        capacity: obs.capacity ?? obs.quantity,
        owner: obs.owner,
        idempotencyKey: `shadow:${obs.bookingId}`,
        bookingId: obs.bookingId,
        correlationId: obs.correlationId,
      });
      // Shadow never holds — release immediately so it can't affect real contention.
      await this.locks
        .release({
          lockId: result.lock.lockId,
          owner: obs.owner,
          fencingToken: result.lock.fencingToken,
        })
        .catch(() => undefined);
      this.metrics.recordInventoryLockOp('shadow', result.replayed ? 'replay' : 'observed_ok');
    } catch {
      // Redis said no while PostgreSQL said yes (or Redis was unavailable): a shadow
      // divergence to measure, never a booking failure.
      this.metrics.recordInventoryLockOp('shadow', 'observed_conflict');
      this.logger.warn(
        `shadow lock divergence scope=${safeScopeId(obs.inventoryKey)} booking=${obs.bookingId}`,
      );
    }
  }
}
