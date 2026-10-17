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

/**
 * The provider was asked about a payment and holds no captured money for it.
 *
 * ── WHY THIS IS NOT "UNAVAILABLE" ─────────────────────────────────────────────────
 * A refund lookup that throws reads as "the provider could not be asked", and the refund
 * console then lets an admin who ticked "I checked the dashboard" send the refund again. An
 * order nobody paid (QA's mock-settled ETG-IND-2026-000013/14/15) is the opposite case: the
 * provider DID answer, and the answer is that there is nothing to refund. It has its own type so
 * the refund code can tell the two apart (`classifyLookupError` in `refunds/refund-reconcile.ts`).
 */
export class PaymentNotCapturedError extends Error {
  constructor(
    readonly paymentRef: string,
    message: string,
  ) {
    super(message);
    this.name = 'PaymentNotCapturedError';
  }
}
