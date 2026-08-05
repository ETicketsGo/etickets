import { Injectable, Logger } from '@nestjs/common';
import { BookingStatus } from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from '../../metrics/metrics.service';
import { RedisLockStore, type RawLock } from './redis-lock.store';
import { safeScopeId } from './inventory-lock.keys';
import type {
  ReconcileInventoryLockRequest,
  ReconcileInventoryLockResult,
  ReconcileMismatch,
} from './inventory-lock.types';

/**
 * Focused reconciliation seam (ADR-039). It scans Redis locks (bounded) and compares
 * each to its authoritative PostgreSQL booking, classifying divergences and applying
 * ONLY unambiguous, safe repairs (releasing a stale Redis lock whose booking is gone/
 * expired, or marking a Redis lock confirmed when the booking already committed).
 * Ambiguous cases (Redis says confirmed but the DB is not) are flagged for MANUAL
 * review — never auto-"fixed", because PostgreSQL is the source of truth.
 *
 * This is deliberately NOT a scheduled repair platform (deferred). The Redis→DB
 * direction is covered; the DB→Redis "missing lock" direction needs a persisted
 * lockId on the booking (a future migration) and is documented, not guessed.
 */
@Injectable()
export class InventoryLockReconciliationService {
  private readonly logger = new Logger('InventoryLockReconcile');

  constructor(
    private readonly store: RedisLockStore,
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {}

  async reconcile(request: ReconcileInventoryLockRequest): Promise<ReconcileInventoryLockResult> {
    const limit = Math.min(request.limit ?? 200, 1000);
    const locks = await this.store.scanRawLocks(limit);
    const mismatches: ReconcileMismatch[] = [];
    let repaired = 0;
    let manual = 0;

    for (const lock of locks) {
      if (request.inventoryKey && lock.inventoryKey !== request.inventoryKey) continue;
      const mismatch = await this.classify(lock);
      if (!mismatch) continue;
      if (request.repair && !mismatch.manualReviewRequired) {
        await this.repair(lock, mismatch);
        mismatch.repaired = true;
        repaired += 1;
        this.metrics.recordInventoryLockReconcile('repaired');
      }
      if (mismatch.manualReviewRequired) {
        manual += 1;
        this.metrics.recordInventoryLockReconcile('manual_review');
      }
      this.metrics.recordInventoryLockReconcile('mismatch');
      this.logger.warn(
        `reconcile mismatch=${mismatch.kind} lockId=${lock.lockId} scope=${safeScopeId(lock.inventoryKey)} ` +
          `repaired=${mismatch.repaired} manual=${mismatch.manualReviewRequired}`,
      );
      mismatches.push(mismatch);
    }

    return { scanned: locks.length, mismatches, repaired, manualReviewRequired: manual };
  }

  /** Compare a Redis lock to its authoritative booking; null ⇒ consistent. */
  private async classify(lock: RawLock): Promise<ReconcileMismatch | null> {
    if (!lock.bookingId) return null; // cannot correlate without a bookingId
    const booking = await this.prisma.booking.findUnique({
      where: { id: lock.bookingId },
      select: { status: true },
    });
    const base = {
      lockId: lock.lockId,
      bookingId: lock.bookingId,
      inventoryKey: lock.inventoryKey,
    };

    if (lock.status === 'ACTIVE') {
      if (
        !booking ||
        booking.status === BookingStatus.EXPIRED ||
        booking.status === BookingStatus.CANCELLED
      ) {
        return {
          ...base,
          kind: booking ? 'DB_HOLD_EXPIRED_REDIS_SURVIVING' : 'REDIS_LOCK_WITHOUT_DB_HOLD',
          repaired: false,
          manualReviewRequired: false,
          detail: 'stale active Redis lock; safe to release',
        };
      }
      if (booking.status === BookingStatus.CONFIRMED) {
        return {
          ...base,
          kind: 'DB_CONFIRMED_REDIS_STILL_ACTIVE',
          repaired: false,
          manualReviewRequired: false,
          detail: 'booking confirmed; mark Redis lock confirmed',
        };
      }
      return null; // ACTIVE ↔ PENDING_PAYMENT: consistent
    }

    if (lock.status === 'CONFIRMED' && booking && booking.status !== BookingStatus.CONFIRMED) {
      return {
        ...base,
        kind: 'REDIS_CONFIRMED_DB_NOT_CONFIRMED',
        repaired: false,
        manualReviewRequired: true, // ambiguous: never auto-resolve against the source of truth
        detail: 'Redis marked confirmed but booking is not confirmed — manual review',
      };
    }
    return null;
  }

  /** Apply the safe, unambiguous repair for a classified mismatch. */
  private async repair(lock: RawLock, mismatch: ReconcileMismatch): Promise<void> {
    if (mismatch.kind === 'DB_CONFIRMED_REDIS_STILL_ACTIVE') {
      await this.store.release(lock, 'CONFIRMED');
    } else {
      // Stale active Redis lock whose DB hold is gone/expired → release it.
      await this.store.release(lock, 'EXPIRED');
    }
  }
}
