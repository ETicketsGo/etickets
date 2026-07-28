import { createHash } from 'node:crypto';

/**
 * Stable, collision-safe Redis key conventions for the inventory-lock engine
 * (ADR-039). Every key is scoped by environment (APP_ENV) so LOCAL/DEV/…/PRODUCTION
 * never collide on a shared Redis, and by the server-validated `inventoryKey`
 * (experience/show/session + pool). No PII is ever embedded in a key.
 *
 * Key families + TTL behaviour:
 *   lock:{lockId}                 → lock JSON;            TTL = lock TTL
 *   seat:{inventoryKey}:{seatId}  → owning lockId;        TTL = lock TTL
 *   qty:{inventoryKey}            → ZSET lockId→expiry;   members purged lazily
 *   qtyh:{inventoryKey}           → HASH lockId→quantity; entries removed on release/expiry
 *   idem:{idempotencyKey}         → lock JSON (replay);   TTL = lock TTL
 *   fence:{inventoryKey}          → INT monotonic token;  TTL ≫ max lifetime (refreshed on use)
 */
export class InventoryLockKeys {
  private readonly base: string;

  constructor(appEnv: string) {
    this.base = `etg:${appEnv.toLowerCase()}:invlock`;
  }

  lock(lockId: string): string {
    return `${this.base}:lock:${lockId}`;
  }

  seat(inventoryKey: string, seatId: string): string {
    return `${this.base}:seat:${inventoryKey}:${seatId}`;
  }

  quantityZset(inventoryKey: string): string {
    return `${this.base}:qty:${inventoryKey}`;
  }

  quantityHash(inventoryKey: string): string {
    return `${this.base}:qtyh:${inventoryKey}`;
  }

  idempotency(idempotencyKey: string): string {
    return `${this.base}:idem:${idempotencyKey}`;
  }

  fence(inventoryKey: string): string {
    return `${this.base}:fence:${inventoryKey}`;
  }

  /** Per-owner active-lock index (ZSET lockId→expiryMs) for abuse-control counting. */
  owner(ownerRef: string): string {
    return `${this.base}:owner:${ownerRef}`;
  }

  /** SCAN glob matching every lock-metadata key (for bounded reconciliation). */
  lockMatch(): string {
    return `${this.base}:lock:*`;
  }
}

/**
 * A short, non-reversible identifier for an inventory scope, safe to put in logs +
 * metric labels (bounds label cardinality and never leaks the raw scope/PII).
 */
export function safeScopeId(inventoryKey: string): string {
  return createHash('sha256').update(inventoryKey).digest('hex').slice(0, 12);
}
