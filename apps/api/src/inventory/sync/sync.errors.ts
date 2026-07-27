import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors';

/**
 * Typed inventory-sync errors (ADR-040). They extend AppException so the global filter
 * renders a SAFE envelope — clients never see secrets, expected signatures, internal
 * key names, DB ids, queue topology, provider credentials, or stack traces.
 */
export const SyncErrorCodes = {
  UNKNOWN_PROVIDER: 'SYNC_UNKNOWN_PROVIDER',
  SIGNATURE_INVALID: 'SYNC_SIGNATURE_INVALID',
  REPLAY_REJECTED: 'SYNC_REPLAY_REJECTED',
  PAYLOAD_TOO_LARGE: 'SYNC_PAYLOAD_TOO_LARGE',
  PAYLOAD_INVALID: 'SYNC_PAYLOAD_INVALID',
  EVENT_DUPLICATE: 'SYNC_EVENT_DUPLICATE',
  UNSUPPORTED_VERSION: 'SYNC_UNSUPPORTED_VERSION',
  MAPPING_MISSING: 'SYNC_MAPPING_MISSING',
  MAPPING_AMBIGUOUS: 'SYNC_MAPPING_AMBIGUOUS',
  MAPPING_CONFLICT: 'SYNC_MAPPING_CONFLICT',
  STALE_UPDATE: 'SYNC_STALE_UPDATE',
  ORDERING_CONFLICT: 'SYNC_ORDERING_CONFLICT',
  RETRYABLE_FAILURE: 'SYNC_RETRYABLE_FAILURE',
  PERMANENT_FAILURE: 'SYNC_PERMANENT_FAILURE',
  RATE_LIMIT_EXCEEDED: 'SYNC_RATE_LIMIT_EXCEEDED',
  CIRCUIT_OPEN: 'SYNC_CIRCUIT_OPEN',
  CHECKPOINT_CONFLICT: 'SYNC_CHECKPOINT_CONFLICT',
  RECONCILIATION_REQUIRED: 'SYNC_RECONCILIATION_REQUIRED',
} as const;

class SyncException extends AppException {}

export class UnknownInventorySyncProviderError extends SyncException {
  constructor(details: Record<string, unknown> = {}) {
    super(
      SyncErrorCodes.UNKNOWN_PROVIDER,
      'Unknown inventory provider.',
      HttpStatus.NOT_FOUND,
      details,
    );
  }
}
export class ProviderWebhookSignatureInvalidError extends SyncException {
  constructor(details: Record<string, unknown> = {}) {
    // Deliberately generic + 401: never reveal expected signature material.
    super(
      SyncErrorCodes.SIGNATURE_INVALID,
      'Signature verification failed.',
      HttpStatus.UNAUTHORIZED,
      details,
    );
  }
}
export class ProviderWebhookReplayRejectedError extends SyncException {
  constructor(details: Record<string, unknown> = {}) {
    super(SyncErrorCodes.REPLAY_REJECTED, 'Request rejected.', HttpStatus.UNAUTHORIZED, details);
  }
}
export class ProviderPayloadTooLargeError extends SyncException {
  constructor(details: Record<string, unknown> = {}) {
    super(
      SyncErrorCodes.PAYLOAD_TOO_LARGE,
      'Payload too large.',
      HttpStatus.PAYLOAD_TOO_LARGE,
      details,
    );
  }
}
export class ProviderPayloadInvalidError extends SyncException {
  constructor(message = 'Payload could not be processed.', details: Record<string, unknown> = {}) {
    super(SyncErrorCodes.PAYLOAD_INVALID, message, HttpStatus.BAD_REQUEST, details);
  }
}
export class ProviderEventDuplicateError extends SyncException {
  constructor(details: Record<string, unknown> = {}) {
    super(SyncErrorCodes.EVENT_DUPLICATE, 'Duplicate event.', HttpStatus.OK, details);
  }
}
export class ProviderEventUnsupportedVersionError extends SyncException {
  constructor(details: Record<string, unknown> = {}) {
    super(
      SyncErrorCodes.UNSUPPORTED_VERSION,
      'Unsupported event version.',
      HttpStatus.UNPROCESSABLE_ENTITY,
      details,
    );
  }
}
export class ProviderMappingMissingError extends SyncException {
  constructor(details: Record<string, unknown> = {}) {
    super(
      SyncErrorCodes.MAPPING_MISSING,
      'No mapping for the external entity.',
      HttpStatus.CONFLICT,
      details,
    );
  }
}
export class ProviderMappingAmbiguousError extends SyncException {
  constructor(details: Record<string, unknown> = {}) {
    super(
      SyncErrorCodes.MAPPING_AMBIGUOUS,
      'Ambiguous mapping requires manual review.',
      HttpStatus.CONFLICT,
      details,
    );
  }
}
export class ProviderMappingConflictError extends SyncException {
  constructor(details: Record<string, unknown> = {}) {
    super(SyncErrorCodes.MAPPING_CONFLICT, 'Mapping conflict.', HttpStatus.CONFLICT, details);
  }
}
export class ProviderSyncStaleUpdateError extends SyncException {
  constructor(details: Record<string, unknown> = {}) {
    super(SyncErrorCodes.STALE_UPDATE, 'Stale update ignored.', HttpStatus.CONFLICT, details);
  }
}
export class ProviderSyncOrderingConflictError extends SyncException {
  constructor(details: Record<string, unknown> = {}) {
    super(
      SyncErrorCodes.ORDERING_CONFLICT,
      'Ordering conflict requires review.',
      HttpStatus.CONFLICT,
      details,
    );
  }
}
export class ProviderSyncRetryableFailureError extends SyncException {
  constructor(message = 'Temporary failure.', details: Record<string, unknown> = {}) {
    super(SyncErrorCodes.RETRYABLE_FAILURE, message, HttpStatus.SERVICE_UNAVAILABLE, details);
  }
}
export class ProviderSyncPermanentFailureError extends SyncException {
  constructor(message = 'Permanent failure.', details: Record<string, unknown> = {}) {
    super(SyncErrorCodes.PERMANENT_FAILURE, message, HttpStatus.UNPROCESSABLE_ENTITY, details);
  }
}
export class ProviderRateLimitExceededError extends SyncException {
  constructor(details: Record<string, unknown> = {}) {
    super(
      SyncErrorCodes.RATE_LIMIT_EXCEEDED,
      'Provider rate limit exceeded.',
      HttpStatus.TOO_MANY_REQUESTS,
      details,
    );
  }
}
export class ProviderCircuitOpenError extends SyncException {
  constructor(details: Record<string, unknown> = {}) {
    super(
      SyncErrorCodes.CIRCUIT_OPEN,
      'Provider temporarily unavailable.',
      HttpStatus.SERVICE_UNAVAILABLE,
      details,
    );
  }
}
export class ProviderCheckpointConflictError extends SyncException {
  constructor(details: Record<string, unknown> = {}) {
    super(SyncErrorCodes.CHECKPOINT_CONFLICT, 'Checkpoint conflict.', HttpStatus.CONFLICT, details);
  }
}
export class ProviderReconciliationRequiredError extends SyncException {
  constructor(details: Record<string, unknown> = {}) {
    super(
      SyncErrorCodes.RECONCILIATION_REQUIRED,
      'Reconciliation required.',
      HttpStatus.CONFLICT,
      details,
    );
  }
}
