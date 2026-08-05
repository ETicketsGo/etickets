/**
 * Provider-neutral distributed inventory-lock contracts (ADR-039).
 *
 * Redis is the FAST coordination + expiration layer (cross-node visibility, TTL,
 * high-contention rejection, short-lived ownership). PostgreSQL remains the final
 * source of truth for what is held/sold — a Redis success never proves a booking. The
 * domain/booking modules depend on {@link InventoryLockService}, never on Redis.
 */

export type InventoryType = 'SEAT' | 'QUANTITY';
export type InventoryLockStatus = 'ACTIVE' | 'RELEASED' | 'EXPIRED' | 'CONFIRMED';

/** The normalized lock record (mirrors what is stored in Redis, PII-free). */
export interface InventoryLock {
  lockId: string;
  holdId: string;
  bookingId?: string;
  inventoryType: InventoryType;
  /** Server-validated scope, e.g. `session:{eventSessionId}`. Never client-chosen raw. */
  inventoryKey: string;
  inventoryUnitIds?: string[];
  quantity?: number;
  ownerId?: string;
  anonymousSessionId?: string;
  providerCode?: string;
  status: InventoryLockStatus;
  /** Monotonically increasing per inventoryKey scope — rejects stale owners. */
  fencingToken: number;
  acquiredAt: string;
  expiresAt: string;
  lastRenewedAt?: string;
  correlationId?: string;
}

/** Who owns a lock. Exactly one of user/anonymous/service identifies the owner. */
export interface LockOwner {
  ownerId?: string;
  anonymousSessionId?: string;
  /** Privileged internal path (reconciliation/expiry) — bypasses owner checks. */
  internal?: boolean;
}

export interface AcquireInventoryLockRequest {
  holdId: string;
  inventoryType: InventoryType;
  inventoryKey: string;
  /** SEAT: the specific unit ids (all-or-nothing). */
  seatIds?: string[];
  /** QUANTITY: units requested + an advisory capacity snapshot (PostgreSQL re-checks). */
  quantity?: number;
  capacity?: number;
  owner: LockOwner;
  /** Same key + same normalized request ⇒ same lock (idempotent). */
  idempotencyKey: string;
  bookingId?: string;
  providerCode?: string;
  correlationId?: string;
  /** Opt-in partial seat acquisition; default (false) is strict all-or-nothing. */
  allowPartial?: boolean;
}

export interface InventoryLockResult {
  lock: InventoryLock;
  /** True when this call replayed an existing lock for the same idempotency key. */
  replayed: boolean;
}

export interface RenewInventoryLockRequest {
  lockId: string;
  /** Credential returned at acquisition; must match the current lock. */
  fencingToken: number;
  owner: LockOwner;
}

export interface ReleaseInventoryLockRequest {
  lockId: string;
  owner: LockOwner;
  /** Optional fencing token; when supplied it is validated (stale ⇒ rejected). */
  fencingToken?: number;
}

export interface ValidateInventoryLockRequest {
  lockId: string;
  fencingToken: number;
  owner?: LockOwner;
}

export interface InventoryLockValidation {
  valid: boolean;
  /** Machine reason when invalid, e.g. `expired` | `token_stale` | `owner_mismatch`. */
  reason?: string;
  lock?: InventoryLock;
}

// ─── Reconciliation ───

export type ReconcileMismatchKind =
  | 'REDIS_LOCK_WITHOUT_DB_HOLD'
  | 'DB_HOLD_WITHOUT_REDIS_LOCK'
  | 'REDIS_CONFIRMED_DB_NOT_CONFIRMED'
  | 'DB_CONFIRMED_REDIS_STILL_ACTIVE'
  | 'QUANTITY_COUNTER_MISMATCH'
  | 'SEAT_OWNERSHIP_MISMATCH'
  | 'DB_HOLD_EXPIRED_REDIS_SURVIVING'
  | 'REDIS_EXPIRED_DB_HOLD_SURVIVING';

export interface ReconcileMismatch {
  kind: ReconcileMismatchKind;
  lockId?: string;
  bookingId?: string;
  inventoryKey?: string;
  /** Whether a safe, unambiguous automatic repair was applied. */
  repaired: boolean;
  /** True when the case is ambiguous and needs manual review (no auto-repair). */
  manualReviewRequired: boolean;
  detail?: string;
}

export interface ReconcileInventoryLockRequest {
  /** Narrow to one scope; omit for a bounded broad sweep. */
  inventoryKey?: string;
  /** Cap on records examined this run (bounded work). */
  limit?: number;
  /** Apply safe repairs (vs detect-only). */
  repair?: boolean;
}

export interface ReconcileInventoryLockResult {
  scanned: number;
  mismatches: ReconcileMismatch[];
  repaired: number;
  manualReviewRequired: number;
}

/** The provider-neutral lock contract domain/booking modules depend on. */
export interface InventoryLockService {
  acquire(request: AcquireInventoryLockRequest): Promise<InventoryLockResult>;
  renew(request: RenewInventoryLockRequest): Promise<InventoryLockResult>;
  release(request: ReleaseInventoryLockRequest): Promise<void>;
  get(lockId: string): Promise<InventoryLock | null>;
  validate(request: ValidateInventoryLockRequest): Promise<InventoryLockValidation>;
  reconcile(request: ReconcileInventoryLockRequest): Promise<ReconcileInventoryLockResult>;
}

export const INVENTORY_LOCK_SERVICE = Symbol('INVENTORY_LOCK_SERVICE');
