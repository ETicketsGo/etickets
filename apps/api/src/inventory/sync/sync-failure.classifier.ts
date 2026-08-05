import { AppException } from '../../common/errors';
import { SyncErrorCodes } from './sync.errors';

/** How a processing failure is classified — drives retry vs terminal handling (ADR-040). */
export type SyncFailureClass =
  | 'RETRYABLE_PROVIDER'
  | 'RETRYABLE_INFRASTRUCTURE'
  | 'PERMANENT_SCHEMA'
  | 'MAPPING_AMBIGUITY'
  | 'UNSUPPORTED_VERSION'
  | 'SECURITY_REJECTION'
  | 'MANUAL_REVIEW';

export interface SyncFailureVerdict {
  class: SyncFailureClass;
  /** Whether the event should be retried (up to max attempts). */
  retryable: boolean;
  /** Terminal RawProviderEvent status when NOT retryable (else RETRYABLE_FAILURE). */
  terminalStatus: 'PERMANENT_FAILURE' | 'MANUAL_REVIEW' | 'REJECTED' | 'RETRYABLE_FAILURE';
}

/**
 * Classify a thrown error into a durable outcome. Permanent/security/version/mapping
 * failures are NEVER retried in a loop; provider/infrastructure failures retry with
 * backoff up to the configured max attempts. See ADR-040.
 */
export function classifySyncFailure(err: unknown): SyncFailureVerdict {
  const code = err instanceof AppException ? err.code : undefined;
  switch (code) {
    case SyncErrorCodes.SIGNATURE_INVALID:
    case SyncErrorCodes.REPLAY_REJECTED:
    case SyncErrorCodes.PAYLOAD_TOO_LARGE:
      return { class: 'SECURITY_REJECTION', retryable: false, terminalStatus: 'REJECTED' };
    case SyncErrorCodes.PAYLOAD_INVALID:
    case SyncErrorCodes.PERMANENT_FAILURE:
      return { class: 'PERMANENT_SCHEMA', retryable: false, terminalStatus: 'PERMANENT_FAILURE' };
    case SyncErrorCodes.UNSUPPORTED_VERSION:
      return { class: 'UNSUPPORTED_VERSION', retryable: false, terminalStatus: 'MANUAL_REVIEW' };
    case SyncErrorCodes.MAPPING_MISSING:
    case SyncErrorCodes.MAPPING_AMBIGUOUS:
    case SyncErrorCodes.MAPPING_CONFLICT:
      return { class: 'MAPPING_AMBIGUITY', retryable: false, terminalStatus: 'MANUAL_REVIEW' };
    case SyncErrorCodes.ORDERING_CONFLICT:
    case SyncErrorCodes.RECONCILIATION_REQUIRED:
      return { class: 'MANUAL_REVIEW', retryable: false, terminalStatus: 'MANUAL_REVIEW' };
    case SyncErrorCodes.RATE_LIMIT_EXCEEDED:
    case SyncErrorCodes.CIRCUIT_OPEN:
    case SyncErrorCodes.RETRYABLE_FAILURE:
      return { class: 'RETRYABLE_PROVIDER', retryable: true, terminalStatus: 'RETRYABLE_FAILURE' };
    default:
      // Unknown errors are treated as retryable infrastructure faults (bounded by attempts).
      return {
        class: 'RETRYABLE_INFRASTRUCTURE',
        retryable: true,
        terminalStatus: 'RETRYABLE_FAILURE',
      };
  }
}
