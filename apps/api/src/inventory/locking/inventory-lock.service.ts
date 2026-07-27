import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { MetricsService } from '../../metrics/metrics.service';
import { RedisLockStore, type RawLock } from './redis-lock.store';
import { safeScopeId } from './inventory-lock.keys';
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
import type {
  AcquireInventoryLockRequest,
  InventoryLock,
  InventoryLockService as IInventoryLockService,
  InventoryLockResult,
  InventoryLockValidation,
  LockOwner,
  ReconcileInventoryLockRequest,
  ReconcileInventoryLockResult,
  RenewInventoryLockRequest,
  ReleaseInventoryLockRequest,
  ValidateInventoryLockRequest,
} from './inventory-lock.types';
import type { InventoryLockReconciliationService } from './inventory-lock-reconciliation.service';

/** Constant-time string compare for owner/credential checks (no length leak). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Distributed inventory lock service (ADR-039) — the provider-neutral policy layer
 * over {@link RedisLockStore}. It enforces idempotency, ownership, fencing, TTL /
 * renewal-window / max-lifetime, and abuse caps, and maps every outcome to a typed,
 * client-safe error. It NEVER publishes domain events (acquiring a Redis lock is not
 * an authoritative fact — the PostgreSQL confirmation seam publishes after commit).
 *
 * PostgreSQL remains the final source of truth; a successful lock here never proves a
 * booking succeeded.
 */
@Injectable()
export class InventoryLockService implements IInventoryLockService {
  private readonly logger = new Logger('InventoryLock');

  constructor(
    private readonly store: RedisLockStore,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
    private readonly reconciliation: InventoryLockReconciliationService,
  ) {}

  async acquire(request: AcquireInventoryLockRequest): Promise<InventoryLockResult> {
    const startedAt = Date.now();
    this.validateRequest(request);
    const lockId = randomUUID();
    const fingerprint = this.fingerprint(request);
    const ownerRef = this.ownerRef(request.owner);

    if (ownerRef && !request.owner.internal) {
      const active = await this.guarded(() => this.store.ownerActiveCount(ownerRef));
      const max = this.config.get<number>('INVENTORY_LOCK_MAX_ACTIVE_PER_OWNER', 20);
      if (active >= max) {
        this.metrics.recordInventoryLockOp('acquire', 'owner_limit');
        throw new InventoryLockValidationError('Too many active holds for this session.', {
          scope: safeScopeId(request.inventoryKey),
        });
      }
    }

    const ttl = this.config.get<number>('INVENTORY_LOCK_TTL_SECONDS', 300);
    const result = await this.guarded(() =>
      request.inventoryType === 'SEAT'
        ? this.store.acquireSeat(
            {
              lockId,
              holdId: request.holdId,
              inventoryKey: request.inventoryKey,
              seatIds: request.seatIds ?? [],
              owner: request.owner,
              fingerprint,
              idempotencyKey: request.idempotencyKey,
              bookingId: request.bookingId,
              providerCode: request.providerCode,
              correlationId: request.correlationId,
            },
            ttl,
          )
        : this.store.acquireQuantity(
            {
              lockId,
              holdId: request.holdId,
              inventoryKey: request.inventoryKey,
              quantity: request.quantity ?? 0,
              capacity: request.capacity ?? 0,
              owner: request.owner,
              fingerprint,
              idempotencyKey: request.idempotencyKey,
              bookingId: request.bookingId,
              providerCode: request.providerCode,
              correlationId: request.correlationId,
            },
            ttl,
          ),
    );

    this.metrics.observeInventoryLockLatency('acquire', (Date.now() - startedAt) / 1000);

    switch (result.status) {
      case 'ACQUIRED':
      case 'REPLAY': {
        const lock = this.map(result.lock as RawLock);
        if (ownerRef && result.status === 'ACQUIRED') {
          await this.guarded(() =>
            this.store.ownerTrack(ownerRef, lock.lockId, (result.lock as RawLock).expiresAtMs),
          ).catch(() => undefined);
        }
        this.metrics.recordInventoryLockOp('acquire', result.status === 'REPLAY' ? 'replay' : 'ok');
        this.log('acquire', lock, result.status === 'REPLAY' ? 'replay' : 'ok', startedAt);
        return { lock, replayed: result.status === 'REPLAY' };
      }
      case 'CONFLICT':
        this.metrics.recordInventoryLockOp('acquire', 'conflict');
        this.metrics.recordInventoryLockContention(
          request.inventoryType,
          safeScopeId(request.inventoryKey),
        );
        throw new InventoryLockConflictError({ scope: safeScopeId(request.inventoryKey) });
      case 'CAPACITY':
        this.metrics.recordInventoryLockOp('acquire', 'capacity');
        this.metrics.recordInventoryLockContention(
          request.inventoryType,
          safeScopeId(request.inventoryKey),
        );
        throw new InventoryLockCapacityExceededError({ scope: safeScopeId(request.inventoryKey) });
      case 'IDEMPOTENCY_CONFLICT':
        this.metrics.recordInventoryLockOp('acquire', 'idempotency_conflict');
        throw new InventoryLockIdempotencyConflictError();
      default:
        this.metrics.recordInventoryLockOp('acquire', 'error');
        throw new InventoryLockValidationError('Unexpected lock acquisition result.');
    }
  }

  async renew(request: RenewInventoryLockRequest): Promise<InventoryLockResult> {
    const raw = await this.guarded(() => this.store.getRaw(request.lockId));
    if (!raw) {
      this.metrics.recordInventoryLockOp('renew', 'expired');
      throw new InventoryLockExpiredError();
    }
    this.assertToken(raw, request.fencingToken, 'renew');
    this.assertOwner(raw, request.owner, 'renew');
    if (raw.status !== 'ACTIVE') {
      this.metrics.recordInventoryLockOp('renew', 'not_active');
      throw new InventoryLockRenewalRejectedError({ reason: raw.status.toLowerCase() });
    }

    const now = Date.now();
    const maxLifetimeMs =
      this.config.get<number>('INVENTORY_LOCK_MAX_LIFETIME_SECONDS', 900) * 1000;
    const windowMs = this.config.get<number>('INVENTORY_LOCK_RENEWAL_WINDOW_SECONDS', 120) * 1000;
    const elapsed = now - raw.acquiredAtMs;
    if (elapsed >= maxLifetimeMs) {
      this.metrics.recordInventoryLockOp('renew', 'max_lifetime');
      throw new InventoryLockRenewalRejectedError({ reason: 'max_lifetime' });
    }
    if (raw.expiresAtMs - now > windowMs) {
      this.metrics.recordInventoryLockOp('renew', 'too_early');
      throw new InventoryLockRenewalRejectedError({ reason: 'renewal_window' });
    }

    const ttl = this.config.get<number>('INVENTORY_LOCK_TTL_SECONDS', 300);
    const remainingLifetimeSec = Math.floor((maxLifetimeMs - elapsed) / 1000);
    const grantedTtl = Math.max(1, Math.min(ttl, remainingLifetimeSec));

    const result = await this.guarded(() => this.store.renew(raw, grantedTtl));
    if (result.status === 'RENEWED') {
      const lock = this.map(result.lock as RawLock);
      const ownerRef = this.ownerRef(request.owner);
      if (ownerRef) {
        await this.guarded(() =>
          this.store.ownerTrack(ownerRef, lock.lockId, (result.lock as RawLock).expiresAtMs),
        ).catch(() => undefined);
      }
      this.metrics.recordInventoryLockOp('renew', 'ok');
      return { lock, replayed: false };
    }
    if (result.status === 'TOKEN_STALE') throw new InventoryLockTokenStaleError();
    this.metrics.recordInventoryLockOp('renew', 'rejected');
    throw new InventoryLockRenewalRejectedError({ reason: result.status.toLowerCase() });
  }

  async release(request: ReleaseInventoryLockRequest): Promise<void> {
    const raw = await this.guarded(() => this.store.getRaw(request.lockId));
    if (!raw) {
      this.metrics.recordInventoryLockOp('release', 'noop');
      return; // idempotent: already gone
    }
    if (!request.owner.internal) {
      this.assertOwner(raw, request.owner, 'release');
      if (request.fencingToken !== undefined)
        this.assertToken(raw, request.fencingToken, 'release');
    }
    await this.guarded(() => this.store.release(raw, 'RELEASED'));
    const ownerRef = this.ownerRef(request.owner) ?? this.ownerRefOf(raw);
    if (ownerRef)
      await this.guarded(() => this.store.ownerUntrack(ownerRef, raw.lockId)).catch(
        () => undefined,
      );
    this.metrics.recordInventoryLockOp('release', 'ok');
  }

  async get(lockId: string): Promise<InventoryLock | null> {
    const raw = await this.guarded(() => this.store.getRaw(lockId));
    return raw ? this.map(raw) : null;
  }

  async validate(request: ValidateInventoryLockRequest): Promise<InventoryLockValidation> {
    const raw = await this.guarded(() => this.store.getRaw(request.lockId));
    if (!raw) return { valid: false, reason: 'expired' };
    if (raw.status !== 'ACTIVE')
      return { valid: false, reason: raw.status.toLowerCase(), lock: this.map(raw) };
    if (Date.now() >= raw.expiresAtMs)
      return { valid: false, reason: 'expired', lock: this.map(raw) };
    if (!safeEqual(String(raw.fencingToken), String(request.fencingToken))) {
      return { valid: false, reason: 'token_stale', lock: this.map(raw) };
    }
    if (request.owner && !this.ownerMatches(raw, request.owner)) {
      return { valid: false, reason: 'owner_mismatch', lock: this.map(raw) };
    }
    return { valid: true, lock: this.map(raw) };
  }

  reconcile(request: ReconcileInventoryLockRequest): Promise<ReconcileInventoryLockResult> {
    return this.reconciliation.reconcile(request);
  }

  /** Internal privileged fetch of the raw lock (for the confirmation seam). */
  async getRaw(lockId: string): Promise<RawLock | null> {
    return this.guarded(() => this.store.getRaw(lockId));
  }

  /** Internal privileged mark (confirmation seam) — release with a final status. */
  async markInternal(
    raw: RawLock,
    finalStatus: 'CONFIRMED' | 'RELEASED' | 'EXPIRED',
  ): Promise<void> {
    await this.guarded(() => this.store.release(raw, finalStatus));
    const ownerRef = this.ownerRefOf(raw);
    if (ownerRef)
      await this.guarded(() => this.store.ownerUntrack(ownerRef, raw.lockId)).catch(
        () => undefined,
      );
  }

  // ─── helpers ───

  private validateRequest(r: AcquireInventoryLockRequest): void {
    if (!r.inventoryKey || !/^[a-zA-Z0-9:_-]+$/.test(r.inventoryKey)) {
      // Server-controlled scope only — clients never pass arbitrary raw scope strings.
      throw new InventoryLockValidationError('Invalid inventory scope.');
    }
    if (!r.idempotencyKey) throw new InventoryLockValidationError('idempotencyKey is required.');
    if (r.inventoryType === 'SEAT') {
      const n = r.seatIds?.length ?? 0;
      const max = this.config.get<number>('INVENTORY_LOCK_MAX_SEATS', 10);
      if (n < 1) throw new InventoryLockValidationError('At least one seat is required.');
      if (n > max) throw new InventoryLockValidationError(`At most ${max} seats per hold.`);
    } else {
      const q = r.quantity ?? 0;
      const max = this.config.get<number>('INVENTORY_LOCK_MAX_QUANTITY', 20);
      if (q < 1) throw new InventoryLockValidationError('Quantity must be at least 1.');
      if (q > max) throw new InventoryLockValidationError(`At most ${max} units per hold.`);
      if ((r.capacity ?? 0) < 0)
        throw new InventoryLockValidationError('Invalid capacity snapshot.');
    }
  }

  /** Stable hash of the normalized request for idempotency-conflict detection. */
  private fingerprint(r: AcquireInventoryLockRequest): string {
    const seats = [...(r.seatIds ?? [])].sort().join(',');
    const parts = [
      r.inventoryType,
      r.inventoryKey,
      seats,
      String(r.quantity ?? ''),
      r.owner.ownerId ?? '',
      r.owner.anonymousSessionId ?? '',
      r.bookingId ?? '',
    ];
    return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);
  }

  private ownerRef(owner: LockOwner): string | null {
    if (owner.ownerId) return `u:${owner.ownerId}`;
    if (owner.anonymousSessionId) return `a:${owner.anonymousSessionId}`;
    return null;
  }

  private ownerRefOf(raw: RawLock): string | null {
    if (raw.ownerId) return `u:${raw.ownerId}`;
    if (raw.anonymousSessionId) return `a:${raw.anonymousSessionId}`;
    return null;
  }

  private ownerMatches(raw: RawLock, owner: LockOwner): boolean {
    if (owner.internal) return true;
    if (raw.ownerId && owner.ownerId) return safeEqual(raw.ownerId, owner.ownerId);
    if (raw.anonymousSessionId && owner.anonymousSessionId) {
      return safeEqual(raw.anonymousSessionId, owner.anonymousSessionId);
    }
    return false;
  }

  private assertOwner(raw: RawLock, owner: LockOwner, op: string): void {
    if (!this.ownerMatches(raw, owner)) {
      this.metrics.recordInventoryLockOp(op, 'owner_mismatch');
      throw new InventoryLockOwnershipMismatchError();
    }
  }

  private assertToken(raw: RawLock, token: number, op: string): void {
    if (!safeEqual(String(raw.fencingToken), String(token))) {
      this.metrics.recordInventoryLockOp(op, 'token_stale');
      throw new InventoryLockTokenStaleError();
    }
  }

  /** Run a Redis op; a transport failure becomes the typed RedisUnavailable error. */
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      this.metrics.recordInventoryLockOp('redis', 'unavailable');
      this.logger.error(
        `redis lock operation failed: ${err instanceof Error ? err.name : 'unknown'}`,
      );
      throw new InventoryLockRedisUnavailableError();
    }
  }

  private map(raw: RawLock): InventoryLock {
    return {
      lockId: raw.lockId,
      holdId: raw.holdId,
      bookingId: raw.bookingId,
      inventoryType: raw.inventoryType,
      inventoryKey: raw.inventoryKey,
      inventoryUnitIds: raw.inventoryUnitIds,
      quantity: raw.quantity,
      ownerId: raw.ownerId,
      anonymousSessionId: raw.anonymousSessionId,
      providerCode: raw.providerCode,
      status: raw.status,
      fencingToken: raw.fencingToken,
      acquiredAt: new Date(raw.acquiredAtMs).toISOString(),
      expiresAt: new Date(raw.expiresAtMs).toISOString(),
      lastRenewedAt: raw.lastRenewedAtMs ? new Date(raw.lastRenewedAtMs).toISOString() : undefined,
      correlationId: raw.correlationId,
    };
  }

  private log(op: string, lock: InventoryLock, outcome: string, startedAt: number): void {
    // Safe identifiers only — no seat-holder PII, secrets, or raw Redis values.
    this.logger.log(
      `op=${op} outcome=${outcome} lockId=${lock.lockId} holdId=${lock.holdId} ` +
        `scope=${safeScopeId(lock.inventoryKey)} fence=${lock.fencingToken} ` +
        `bookingId=${lock.bookingId ?? '-'} corr=${lock.correlationId ?? '-'} ` +
        `durMs=${Date.now() - startedAt}`,
    );
  }
}
