// Pure retry/backoff policy for the durable offline check-in queue (ADR-035).
// Framework-free so it can be unit-tested and shared by the organizer queue. It never
// decides that a scan is ACCEPTED — only the server does that. This layer only decides
// WHEN/WHETHER a failed sync attempt may be retried, and when it must dead-letter.

export type QueueFailureCategory = 'RETRYABLE_NETWORK' | 'RETRYABLE_SERVER' | 'NON_RETRYABLE';

export interface QueueFailure {
  category: QueueFailureCategory;
  retryable: boolean;
  /** Safe, operator-facing message (no internals/secrets). */
  message: string;
}

/** Bounded exponential backoff parameters. */
export const QUEUE_MAX_RETRIES = 6;
export const QUEUE_BACKOFF_BASE_MS = 5_000;
export const QUEUE_BACKOFF_MAX_MS = 300_000;

/**
 * Classifies a sync transport failure. Pass `'network'` when the request never got a
 * response (offline/DNS/abort), or the HTTP status code the server returned. 5xx/429
 * are retryable; 4xx are authoritative rejections and are NEVER retried automatically.
 */
export function classifyQueueFailure(input: 'network' | number): QueueFailure {
  if (input === 'network') {
    return {
      category: 'RETRYABLE_NETWORK',
      retryable: true,
      message: 'No connection — the device will keep the scans and retry automatically.',
    };
  }
  if (input >= 500) {
    return {
      category: 'RETRYABLE_SERVER',
      retryable: true,
      message: 'The server had a temporary problem — the device will retry automatically.',
    };
  }
  if (input === 429) {
    return {
      category: 'RETRYABLE_SERVER',
      retryable: true,
      message: 'The server is busy — the device will retry automatically.',
    };
  }
  if (input === 403) {
    return {
      category: 'NON_RETRYABLE',
      retryable: false,
      message:
        'This device is not permitted to sync (it may be revoked). Ask a manager to review it.',
    };
  }
  return {
    category: 'NON_RETRYABLE',
    retryable: false,
    message:
      'The server rejected this sync and it will not be retried automatically. Review it manually.',
  };
}

/** Bounded exponential backoff for the Nth retry (0-indexed prior attempts). */
export function backoffDelayMs(priorAttempts: number): number {
  const n = Math.max(0, Math.floor(priorAttempts));
  const delay = QUEUE_BACKOFF_BASE_MS * 2 ** n;
  return Math.min(delay, QUEUE_BACKOFF_MAX_MS);
}

export type RetryDisposition = 'RETRYING' | 'BLOCKED';

export interface RetryPlan {
  disposition: RetryDisposition;
  retryCount: number;
  lastAttemptAt: number;
  /** When the record becomes eligible again; null when dead-lettered. */
  nextAttemptAt: number | null;
  failureCategory: QueueFailureCategory;
  failureMessage: string;
}

/**
 * Decides what happens to a record after a failed sync attempt. A non-retryable
 * failure, or exhausting the retry budget, dead-letters it (BLOCKED) — it is never
 * discarded and never marked ACCEPTED. Retryable failures schedule the next attempt
 * with bounded exponential backoff.
 */
export function planRetry(
  currentRetryCount: number,
  failure: QueueFailure,
  now: number,
  maxRetries: number = QUEUE_MAX_RETRIES,
): RetryPlan {
  const base = {
    lastAttemptAt: now,
    failureCategory: failure.category,
    failureMessage: failure.message,
  };
  if (!failure.retryable) {
    return { ...base, disposition: 'BLOCKED', retryCount: currentRetryCount, nextAttemptAt: null };
  }
  const retryCount = currentRetryCount + 1;
  if (retryCount > maxRetries) {
    return { ...base, disposition: 'BLOCKED', retryCount, nextAttemptAt: null };
  }
  return {
    ...base,
    disposition: 'RETRYING',
    retryCount,
    nextAttemptAt: now + backoffDelayMs(currentRetryCount),
  };
}

/**
 * Whether a record may be attempted now: a fresh PENDING record, or a RETRYING record
 * whose backoff window has elapsed. BLOCKED (dead-letter) records require a deliberate
 * manual retry; server-authoritative terminal outcomes are never re-attempted here.
 */
export function isSyncEligible(
  record: { status: string; nextAttemptAt?: number | null },
  now: number,
): boolean {
  if (record.status === 'PENDING') return true;
  if (record.status === 'RETRYING')
    return record.nextAttemptAt != null && record.nextAttemptAt <= now;
  return false;
}
