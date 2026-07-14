/**
 * Normalized payment errors. Every adapter translates provider-specific failures
 * into one of these codes so the orchestration/failover layers can reason about
 * retryability without knowing the provider. Never leak raw provider errors.
 */
export const PaymentErrorCode = {
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE', // transient — safe to fail over/retry
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT', // transient
  AUTHENTICATION_FAILED: 'AUTHENTICATION_FAILED', // bad/placeholder credentials — do NOT retry
  INVALID_REQUEST: 'INVALID_REQUEST', // our request was malformed — do NOT retry
  CARD_DECLINED: 'CARD_DECLINED', // terminal for this attempt
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  DUPLICATE: 'DUPLICATE', // idempotency conflict
  WEBHOOK_INVALID: 'WEBHOOK_INVALID',
  UNSUPPORTED: 'UNSUPPORTED', // capability not supported by this provider
  UNKNOWN: 'UNKNOWN',
} as const;
export type PaymentErrorCode = (typeof PaymentErrorCode)[keyof typeof PaymentErrorCode];

/** Error codes for which failing over to another provider / retrying is safe. */
const RETRYABLE: ReadonlySet<PaymentErrorCode> = new Set([
  PaymentErrorCode.PROVIDER_UNAVAILABLE,
  PaymentErrorCode.PROVIDER_TIMEOUT,
]);

/**
 * A provider-agnostic payment error. Carries the normalized code, the provider
 * that produced it, and whether it is safe to retry/fail over. The optional
 * `causeError` keeps the original error for logging (never surfaced to clients).
 */
export class PaymentProviderError extends Error {
  constructor(
    readonly code: PaymentErrorCode,
    message: string,
    readonly provider: string,
    readonly causeError?: unknown,
  ) {
    super(message);
    this.name = 'PaymentProviderError';
  }

  /** Whether the orchestrator may fail over to another provider / retry. */
  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }
}
