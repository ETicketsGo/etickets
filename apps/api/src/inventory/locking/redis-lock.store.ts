import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';
import { InventoryLockKeys } from './inventory-lock.keys';
import {
  QUANTITY_ACQUIRE,
  QUANTITY_RELEASE,
  QUANTITY_RENEW,
  SEAT_ACQUIRE,
  SEAT_RELEASE,
  SEAT_RENEW,
} from './inventory-lock.scripts';
import type { InventoryLockStatus, InventoryType } from './inventory-lock.types';

/** The lock as stored in Redis (epoch-ms timestamps; a `fingerprint` for idempotency). */
export interface RawLock {
  lockId: string;
  holdId: string;
  bookingId?: string;
  inventoryType: InventoryType;
  inventoryKey: string;
  inventoryUnitIds?: string[];
  quantity?: number;
  ownerId?: string;
  anonymousSessionId?: string;
  providerCode?: string;
  status: InventoryLockStatus;
  fencingToken: number;
  ttlSeconds: number;
  acquiredAtMs: number;
  expiresAtMs: number;
  lastRenewedAtMs?: number;
  fingerprint: string;
  correlationId?: string;
}

export interface ScriptResult {
  status: string;
  lock?: RawLock;
  /** Present for CONFLICT (the offending seat key). */
  conflictKey?: string;
  /** Present for CAPACITY (held quantity observed). */
  held?: number;
}

export interface AcquireSeatParams {
  lockId: string;
  holdId: string;
  inventoryKey: string;
  seatIds: string[];
  owner: { ownerId?: string; anonymousSessionId?: string };
  fingerprint: string;
  idempotencyKey: string;
  bookingId?: string;
  providerCode?: string;
  correlationId?: string;
}

export interface AcquireQuantityParams {
  lockId: string;
  holdId: string;
  inventoryKey: string;
  quantity: number;
  capacity: number;
  owner: { ownerId?: string; anonymousSessionId?: string };
  fingerprint: string;
  idempotencyKey: string;
  bookingId?: string;
  providerCode?: string;
  correlationId?: string;
}

/**
 * Thin, transport-specific adapter over Redis: runs the atomic Lua scripts (ADR-039)
 * and reuses the shared {@link RedisService} ioredis client — no new client, no
 * Redlock. It builds keys, marshals args, and parses the `[status, payload]` result.
 * All coordination decisions live in the scripts; policy lives in the service above.
 */
@Injectable()
export class RedisLockStore {
  private readonly keys: InventoryLockKeys;
  private readonly fenceTtlSeconds: number;

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {
    this.keys = new InventoryLockKeys(this.config.get<string>('APP_ENV', 'LOCAL'));
    // Fence counters must outlive any active lock in their scope; a generous multiple
    // of max lifetime lets long-idle scopes eventually expire without harming
    // monotonicity while any lock could still exist.
    this.fenceTtlSeconds = this.config.get<number>('INVENTORY_LOCK_MAX_LIFETIME_SECONDS', 900) * 4;
  }

  async isHealthy(): Promise<boolean> {
    return this.redis.ping();
  }

  private now(): number {
    return Date.now();
  }

  private async eval(
    script: string,
    keys: string[],
    args: (string | number)[],
  ): Promise<ScriptResult> {
    const res = (await this.redis.client.eval(script, keys.length, ...keys, ...args)) as [
      string,
      string,
    ];
    const [status, payload] = res;
    if (status === 'ACQUIRED' || status === 'REPLAY' || status === 'RENEWED') {
      return { status, lock: JSON.parse(payload) as RawLock };
    }
    if (status === 'CONFLICT') return { status, conflictKey: payload };
    if (status === 'CAPACITY') return { status, held: Number(payload) };
    return { status };
  }

  async acquireSeat(p: AcquireSeatParams, ttlSeconds: number): Promise<ScriptResult> {
    const keys = [
      this.keys.idempotency(p.idempotencyKey),
      this.keys.fence(p.inventoryKey),
      this.keys.lock(p.lockId),
      ...p.seatIds.map((s) => this.keys.seat(p.inventoryKey, s)),
    ];
    const args = [
      p.lockId,
      p.holdId,
      p.owner.ownerId ?? '',
      p.owner.anonymousSessionId ?? '',
      'SEAT',
      p.inventoryKey,
      ttlSeconds,
      this.now(),
      p.fingerprint,
      p.correlationId ?? '',
      p.bookingId ?? '',
      p.providerCode ?? '',
      p.seatIds.join(','),
      this.fenceTtlSeconds,
    ];
    return this.eval(SEAT_ACQUIRE, keys, args);
  }

  async acquireQuantity(p: AcquireQuantityParams, ttlSeconds: number): Promise<ScriptResult> {
    const keys = [
      this.keys.idempotency(p.idempotencyKey),
      this.keys.fence(p.inventoryKey),
      this.keys.lock(p.lockId),
      this.keys.quantityZset(p.inventoryKey),
      this.keys.quantityHash(p.inventoryKey),
    ];
    const args = [
      p.lockId,
      p.holdId,
      p.owner.ownerId ?? '',
      p.owner.anonymousSessionId ?? '',
      p.inventoryKey,
      ttlSeconds,
      this.now(),
      p.fingerprint,
      p.correlationId ?? '',
      p.bookingId ?? '',
      p.providerCode ?? '',
      p.quantity,
      p.capacity,
      this.fenceTtlSeconds,
    ];
    return this.eval(QUANTITY_ACQUIRE, keys, args);
  }

  async renew(lock: RawLock, ttlSeconds: number): Promise<ScriptResult> {
    if (lock.inventoryType === 'SEAT') {
      const keys = [
        this.keys.lock(lock.lockId),
        ...(lock.inventoryUnitIds ?? []).map((s) => this.keys.seat(lock.inventoryKey, s)),
      ];
      return this.eval(SEAT_RENEW, keys, [
        lock.lockId,
        String(lock.fencingToken),
        ttlSeconds,
        this.now(),
      ]);
    }
    return this.eval(
      QUANTITY_RENEW,
      [this.keys.lock(lock.lockId), this.keys.quantityZset(lock.inventoryKey)],
      [lock.lockId, String(lock.fencingToken), ttlSeconds, this.now()],
    );
  }

  async release(lock: RawLock, finalStatus: InventoryLockStatus, tombstoneTtl = 60): Promise<void> {
    if (lock.inventoryType === 'SEAT') {
      const keys = [
        this.keys.lock(lock.lockId),
        ...(lock.inventoryUnitIds ?? []).map((s) => this.keys.seat(lock.inventoryKey, s)),
      ];
      await this.eval(SEAT_RELEASE, keys, [lock.lockId, finalStatus, tombstoneTtl]);
      return;
    }
    await this.eval(
      QUANTITY_RELEASE,
      [
        this.keys.lock(lock.lockId),
        this.keys.quantityZset(lock.inventoryKey),
        this.keys.quantityHash(lock.inventoryKey),
      ],
      [lock.lockId, finalStatus, tombstoneTtl],
    );
  }

  async getRaw(lockId: string): Promise<RawLock | null> {
    const raw = await this.redis.client.get(this.keys.lock(lockId));
    return raw ? (JSON.parse(raw) as RawLock) : null;
  }

  // ─── Per-owner active-lock index (best-effort abuse control; the authoritative
  // oversell guard remains PostgreSQL + the atomic seat/quantity scripts) ───

  /** Count an owner's currently-active locks, lazily purging expired entries. */
  async ownerActiveCount(ownerRef: string, now = this.now()): Promise<number> {
    const key = this.keys.owner(ownerRef);
    await this.redis.client.zremrangebyscore(key, '-inf', `(${now}`);
    return this.redis.client.zcard(key);
  }

  async ownerTrack(ownerRef: string, lockId: string, expiresAtMs: number): Promise<void> {
    const key = this.keys.owner(ownerRef);
    await this.redis.client.zadd(key, expiresAtMs, lockId);
    await this.redis.client.expire(key, this.fenceTtlSeconds);
  }

  async ownerUntrack(ownerRef: string, lockId: string): Promise<void> {
    await this.redis.client.zrem(this.keys.owner(ownerRef), lockId);
  }

  /**
   * Bounded SCAN of lock-metadata keys for reconciliation (never a full KEYS on a
   * production Redis). Stops once `limit` locks are collected.
   */
  async scanRawLocks(limit: number): Promise<RawLock[]> {
    const out: RawLock[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.client.scan(
        cursor,
        'MATCH',
        this.keys.lockMatch(),
        'COUNT',
        100,
      );
      cursor = next;
      for (const key of keys) {
        if (out.length >= limit) break;
        const raw = await this.redis.client.get(key);
        if (raw) out.push(JSON.parse(raw) as RawLock);
      }
    } while (cursor !== '0' && out.length < limit);
    return out;
  }
}
