import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors';

/**
 * Typed inventory-lock errors (ADR-039). They extend AppException so the global
 * filter renders a SAFE envelope: the client sees a stable code + generic message and
 * NEVER Redis internals, key names, stack traces, secrets, or topology.
 */
export const InventoryLockErrorCodes = {
  CONFLICT: 'INVENTORY_LOCK_CONFLICT',
  UNAVAILABLE: 'INVENTORY_LOCK_UNAVAILABLE',
  EXPIRED: 'INVENTORY_LOCK_EXPIRED',
  OWNERSHIP_MISMATCH: 'INVENTORY_LOCK_OWNERSHIP_MISMATCH',
  TOKEN_STALE: 'INVENTORY_LOCK_TOKEN_STALE',
  IDEMPOTENCY_CONFLICT: 'INVENTORY_LOCK_IDEMPOTENCY_CONFLICT',
  RENEWAL_REJECTED: 'INVENTORY_LOCK_RENEWAL_REJECTED',
  CAPACITY_EXCEEDED: 'INVENTORY_LOCK_CAPACITY_EXCEEDED',
  REDIS_UNAVAILABLE: 'INVENTORY_LOCK_REDIS_UNAVAILABLE',
  CONFIRMATION_FAILED: 'INVENTORY_LOCK_CONFIRMATION_FAILED',
  RECONCILIATION_REQUIRED: 'INVENTORY_LOCK_RECONCILIATION_REQUIRED',
  VALIDATION_FAILED: 'INVENTORY_LOCK_VALIDATION_FAILED',
} as const;

/** One or more requested seats are actively held by another owner. */
export class InventoryLockConflictError extends AppException {
  constructor(details: Record<string, unknown> = {}) {
    super(
      InventoryLockErrorCodes.CONFLICT,
      'One or more of the selected seats are currently held by someone else.',
      HttpStatus.CONFLICT,
      details,
    );
  }
}

/** Locking is required but cannot be performed right now. */
export class InventoryLockUnavailableError extends AppException {
  constructor(details: Record<string, unknown> = {}) {
    super(
      InventoryLockErrorCodes.UNAVAILABLE,
      'Inventory could not be locked. Please try again.',
      HttpStatus.SERVICE_UNAVAILABLE,
      details,
    );
  }
}

export class InventoryLockExpiredError extends AppException {
  constructor(details: Record<string, unknown> = {}) {
    super(
      InventoryLockErrorCodes.EXPIRED,
      'Your seat hold has expired. Please start again.',
      HttpStatus.CONFLICT,
      details,
    );
  }
}

export class InventoryLockOwnershipMismatchError extends AppException {
  constructor(details: Record<string, unknown> = {}) {
    super(
      InventoryLockErrorCodes.OWNERSHIP_MISMATCH,
      'This hold belongs to a different session.',
      HttpStatus.FORBIDDEN,
      details,
    );
  }
}

export class InventoryLockTokenStaleError extends AppException {
  constructor(details: Record<string, unknown> = {}) {
    super(
      InventoryLockErrorCodes.TOKEN_STALE,
      'This hold has been superseded. Please start again.',
      HttpStatus.CONFLICT,
      details,
    );
  }
}

export class InventoryLockIdempotencyConflictError extends AppException {
  constructor(details: Record<string, unknown> = {}) {
    super(
      InventoryLockErrorCodes.IDEMPOTENCY_CONFLICT,
      'This request key was already used with different details.',
      HttpStatus.CONFLICT,
      details,
    );
  }
}

export class InventoryLockRenewalRejectedError extends AppException {
  constructor(details: Record<string, unknown> = {}) {
    super(
      InventoryLockErrorCodes.RENEWAL_REJECTED,
      'This hold can no longer be extended.',
      HttpStatus.CONFLICT,
      details,
    );
  }
}

export class InventoryLockCapacityExceededError extends AppException {
  constructor(details: Record<string, unknown> = {}) {
    super(
      InventoryLockErrorCodes.CAPACITY_EXCEEDED,
      'Not enough inventory is available for the requested quantity.',
      HttpStatus.CONFLICT,
      details,
    );
  }
}

/** Redis is unreachable; in active mode we FAIL CLOSED rather than risk oversell. */
export class InventoryLockRedisUnavailableError extends AppException {
  constructor(details: Record<string, unknown> = {}) {
    super(
      InventoryLockErrorCodes.REDIS_UNAVAILABLE,
      'Seat coordination is temporarily unavailable. Please try again.',
      HttpStatus.SERVICE_UNAVAILABLE,
      details,
    );
  }
}

export class InventoryLockConfirmationFailedError extends AppException {
  constructor(details: Record<string, unknown> = {}) {
    super(
      InventoryLockErrorCodes.CONFIRMATION_FAILED,
      'The booking could not be confirmed. Please try again.',
      HttpStatus.CONFLICT,
      details,
    );
  }
}

/** Raised when a Redis/PostgreSQL divergence needs reconciliation (observable). */
export class InventoryLockReconciliationRequiredError extends AppException {
  constructor(details: Record<string, unknown> = {}) {
    super(
      InventoryLockErrorCodes.RECONCILIATION_REQUIRED,
      'A temporary inconsistency was detected and flagged for reconciliation.',
      HttpStatus.CONFLICT,
      details,
    );
  }
}

export class InventoryLockValidationError extends AppException {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(InventoryLockErrorCodes.VALIDATION_FAILED, message, HttpStatus.BAD_REQUEST, details);
  }
}
