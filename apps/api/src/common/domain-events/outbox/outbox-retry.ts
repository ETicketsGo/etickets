import { OutboxError } from './outbox.errors';

/** How a delivery failure is classified — drives retry vs terminal handling (ADR-041). */
export type OutboxFailureClass = 'RETRYABLE' | 'PERMANENT' | 'MANUAL_REVIEW';

export interface OutboxFailureVerdict {
  class: OutboxFailureClass;
  /** Terminal status when NOT retryable (else RETRYABLE_FAILURE). */
  terminalStatus: 'DEAD_LETTERED' | 'MANUAL_REVIEW' | 'RETRYABLE_FAILURE';
}

/**
 * Classify a delivery failure. Envelope/serialization/version faults are permanent (no
 * loop); manual-review requests escalate; everything else (handler/db/redis/network/
 * timeout/circuit) is retryable. See ADR-041.
 */
export function classifyOutboxFailure(err: unknown): OutboxFailureVerdict {
  const code = err instanceof OutboxError ? err.code : undefined;
  switch (code) {
    case 'OUTBOX_SERIALIZATION_INVALID':
    case 'OUTBOX_PAYLOAD_TOO_LARGE':
    case 'OUTBOX_DELIVERY_PERMANENT':
      return { class: 'PERMANENT', terminalStatus: 'DEAD_LETTERED' };
    case 'OUTBOX_UNSUPPORTED_VERSION':
    case 'OUTBOX_MANUAL_REVIEW':
      return { class: 'MANUAL_REVIEW', terminalStatus: 'MANUAL_REVIEW' };
    default:
      return { class: 'RETRYABLE', terminalStatus: 'RETRYABLE_FAILURE' };
  }
}

/**
 * Exponential backoff with full jitter, bounded by `maxSeconds`. `attempt` is the
 * number of attempts already made (>=1). Returns the next `availableAt` instant.
 */
export function nextAvailableAt(
  attempt: number,
  baseSeconds: number,
  maxSeconds: number,
  now: number = Date.now(),
  random: () => number = Math.random,
): Date {
  const exp = Math.min(maxSeconds, baseSeconds * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.floor(exp * (0.5 + 0.5 * random())); // full jitter over [0.5x, 1x]
  return new Date(now + jittered * 1000);
}
