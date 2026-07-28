/**
 * Outbox error types (ADR-041). Serialization/validation errors thrown during RECORDING
 * propagate out of the business transaction and roll it back (required-event semantics).
 * Delivery errors are classified by the dispatcher into retry / terminal / review.
 */
export abstract class OutboxError extends Error {
  abstract readonly code: string;
  constructor(
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Envelope/payload could not be serialized or is structurally invalid. Permanent. */
export class OutboxSerializationError extends OutboxError {
  readonly code = 'OUTBOX_SERIALIZATION_INVALID';
}

/** Payload exceeds the configured byte limit. Permanent. */
export class OutboxPayloadTooLargeError extends OutboxError {
  readonly code = 'OUTBOX_PAYLOAD_TOO_LARGE';
}

/** Event version is not supported by any registered handler contract. Manual review. */
export class OutboxUnsupportedVersionError extends OutboxError {
  readonly code = 'OUTBOX_UNSUPPORTED_VERSION';
}

/** A handler/delivery failure that should be retried with backoff. */
export class OutboxDeliveryRetryableError extends OutboxError {
  readonly code = 'OUTBOX_DELIVERY_RETRYABLE';
}

/** A delivery failure that must NOT be retried. Terminal. */
export class OutboxDeliveryPermanentError extends OutboxError {
  readonly code = 'OUTBOX_DELIVERY_PERMANENT';
}

/** A delivery outcome that needs a human (ambiguous / handler-requested review). */
export class OutboxManualReviewError extends OutboxError {
  readonly code = 'OUTBOX_MANUAL_REVIEW';
}
