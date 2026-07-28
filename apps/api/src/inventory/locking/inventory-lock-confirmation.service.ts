import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { MetricsService } from '../../metrics/metrics.service';
import { DOMAIN_EVENT_BUS, type DomainEventBus } from '../../common/domain-events';
import type { DomainEvent } from '../../common/domain-events';
import { InventoryLockService } from './inventory-lock.service';
import { InventoryLockConfirmationFailedError } from './inventory-lock.errors';
import type { InventoryLock, LockOwner } from './inventory-lock.types';

export interface ConfirmInventoryLockRequest {
  lockId: string;
  fencingToken: number;
  owner: LockOwner;
}

export interface ConfirmInventoryLockResult<T> {
  work: T;
  lock: InventoryLock | null;
  /** True when PostgreSQL committed but the Redis cleanup failed (needs reconcile). */
  reconciliationRequired: boolean;
}

/**
 * Confirmation / conversion seam (ADR-039). It sequences the ONLY correct order:
 *
 *   validate lock (active + fencing token + ownership)
 *     → run the caller's authoritative PostgreSQL transaction (InventoryStrategy
 *       confirm + durable booking state + COMMIT)
 *     → mark the Redis lock CONFIRMED
 *     → publish domain events AFTER commit (when enabled)
 *
 * Redis is NEVER marked sold before PostgreSQL commits. If PostgreSQL fails, the lock
 * stays ACTIVE (TTL / explicit release) and a typed failure is returned — retry-safe.
 * If PostgreSQL commits but Redis cleanup fails, the booking STANDS and the divergence
 * is recorded as an observable reconciliation requirement (never a fake rollback).
 */
@Injectable()
export class InventoryLockConfirmationService {
  private readonly logger = new Logger('InventoryLockConfirm');

  constructor(
    private readonly locks: InventoryLockService,
    private readonly metrics: MetricsService,
    @Optional() @Inject(DOMAIN_EVENT_BUS) private readonly events?: DomainEventBus,
  ) {}

  /**
   * @param work the authoritative PostgreSQL transaction (must commit inside it).
   * @param afterCommitEvents domain events to publish only after a successful commit.
   */
  async confirm<T>(
    request: ConfirmInventoryLockRequest,
    work: () => Promise<T>,
    afterCommitEvents: DomainEvent[] = [],
  ): Promise<ConfirmInventoryLockResult<T>> {
    const raw = await this.locks.getRaw(request.lockId);
    if (!raw) {
      this.metrics.recordInventoryLockOp('confirm', 'expired');
      throw new InventoryLockConfirmationFailedError({ reason: 'lock_expired' });
    }
    const validation = await this.locks.validate({
      lockId: request.lockId,
      fencingToken: request.fencingToken,
      owner: request.owner,
    });
    if (!validation.valid) {
      this.metrics.recordInventoryLockOp('confirm', validation.reason ?? 'invalid');
      throw new InventoryLockConfirmationFailedError({ reason: validation.reason });
    }

    // Authoritative PostgreSQL transaction. A failure leaves the Redis lock ACTIVE.
    let workResult: T;
    try {
      workResult = await work();
    } catch (err) {
      this.metrics.recordInventoryLockOp('confirm', 'db_failed');
      this.logger.warn(
        `confirmation PostgreSQL tx failed for lockId=${request.lockId}; lock left active for retry`,
      );
      throw new InventoryLockConfirmationFailedError({ reason: 'db_transaction_failed' });
    }

    // Committed. Redis cleanup + events are best-effort and NEVER roll the commit back.
    let reconciliationRequired = false;
    try {
      await this.locks.markInternal(raw, 'CONFIRMED');
    } catch {
      reconciliationRequired = true;
      this.metrics.recordInventoryLockOp('confirm', 'redis_cleanup_failed');
      this.metrics.recordInventoryLockReconcile('mismatch');
      this.logger.error(
        `PostgreSQL committed but Redis lock cleanup failed for lockId=${request.lockId}; reconciliation required`,
      );
    }

    if (afterCommitEvents.length > 0 && this.events) {
      try {
        await this.events.publishMany(afterCommitEvents);
      } catch {
        this.logger.error(`post-commit domain event publish failed for lockId=${request.lockId}`);
      }
    }

    this.metrics.recordInventoryLockOp('confirm', reconciliationRequired ? 'ok_reconcile' : 'ok');
    return {
      work: workResult,
      lock: this.locks ? await this.locks.get(request.lockId) : null,
      reconciliationRequired,
    };
  }
}
