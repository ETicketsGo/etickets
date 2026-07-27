import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors';

/**
 * Typed booking-orchestration errors (ADR-042). Client-safe: no provider secrets, no
 * internal identifiers beyond what the client already owns, no stack traces.
 */
export const BookingOrchestratorErrorCodes = {
  INVALID_TRANSITION: 'BOOKING_INVALID_TRANSITION',
  WORKFLOW_CONFLICT: 'BOOKING_WORKFLOW_CONFLICT',
  WORKFLOW_NOT_FOUND: 'BOOKING_WORKFLOW_NOT_FOUND',
  INVENTORY_UNRESOLVED: 'BOOKING_INVENTORY_UNRESOLVED',
  LOCK_REQUIRED_UNAVAILABLE: 'BOOKING_LOCK_REQUIRED_UNAVAILABLE',
  PROVIDER_CONFIRM_FAILED: 'BOOKING_PROVIDER_CONFIRM_FAILED',
  COMPENSATION_REQUIRED: 'BOOKING_COMPENSATION_REQUIRED',
  MANUAL_REVIEW_REQUIRED: 'BOOKING_MANUAL_REVIEW_REQUIRED',
  IDEMPOTENCY_CONFLICT: 'BOOKING_IDEMPOTENCY_CONFLICT',
  ORCHESTRATOR_DISABLED: 'BOOKING_ORCHESTRATOR_DISABLED',
} as const;

/** An attempted workflow transition is not allowed from the current state. */
export class InvalidBookingTransitionError extends AppException {
  constructor(from: string, to: string) {
    super(
      BookingOrchestratorErrorCodes.INVALID_TRANSITION,
      'This booking cannot change in the requested way from its current state.',
      HttpStatus.CONFLICT,
      { from, to },
    );
  }
}

/** Optimistic-concurrency conflict: another worker/callback advanced the workflow first. */
export class BookingWorkflowConflictError extends AppException {
  constructor(details: Record<string, unknown> = {}) {
    super(
      BookingOrchestratorErrorCodes.WORKFLOW_CONFLICT,
      'This booking is being updated by another request. Please retry.',
      HttpStatus.CONFLICT,
      details,
    );
  }
}

export class BookingWorkflowNotFoundError extends AppException {
  constructor(details: Record<string, unknown> = {}) {
    super(
      BookingOrchestratorErrorCodes.WORKFLOW_NOT_FOUND,
      'Booking workflow not found.',
      HttpStatus.NOT_FOUND,
      details,
    );
  }
}

export class BookingProviderConfirmationFailedError extends AppException {
  constructor(details: Record<string, unknown> = {}) {
    super(
      BookingOrchestratorErrorCodes.PROVIDER_CONFIRM_FAILED,
      'The booking could not be confirmed with the provider. Please try again.',
      HttpStatus.CONFLICT,
      details,
    );
  }
}

export class BookingCompensationRequiredError extends AppException {
  constructor(details: Record<string, unknown> = {}) {
    super(
      BookingOrchestratorErrorCodes.COMPENSATION_REQUIRED,
      'The booking hit an error and is being safely recovered.',
      HttpStatus.CONFLICT,
      details,
    );
  }
}

export class BookingIdempotencyConflictError extends AppException {
  constructor(details: Record<string, unknown> = {}) {
    super(
      BookingOrchestratorErrorCodes.IDEMPOTENCY_CONFLICT,
      'This request key was already used with different booking details.',
      HttpStatus.CONFLICT,
      details,
    );
  }
}
