import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors';

/**
 * Typed provider/allocation failure classifications (ADR-042 §21, P5.2B). These are the
 * INTERNAL vocabulary the orchestrator + reconciliation branch on; each maps to a SAFE
 * customer-facing response that never leaks provider internals, secrets, or raw responses.
 */
export const ExternalBookingFailure = {
  PROVIDER_SOLD_OUT: 'PROVIDER_SOLD_OUT',
  PROVIDER_RESERVATION_EXPIRED: 'PROVIDER_RESERVATION_EXPIRED',
  PROVIDER_RESERVATION_REJECTED: 'PROVIDER_RESERVATION_REJECTED',
  PROVIDER_CONFIRMATION_REJECTED: 'PROVIDER_CONFIRMATION_REJECTED',
  PROVIDER_CONFIRMATION_AMBIGUOUS: 'PROVIDER_CONFIRMATION_AMBIGUOUS',
  PROVIDER_TEMPORARILY_UNAVAILABLE: 'PROVIDER_TEMPORARILY_UNAVAILABLE',
  PROVIDER_CIRCUIT_OPEN: 'PROVIDER_CIRCUIT_OPEN',
  PROVIDER_MAPPING_MISSING: 'PROVIDER_MAPPING_MISSING',
  PROVIDER_MAPPING_AMBIGUOUS: 'PROVIDER_MAPPING_AMBIGUOUS',
  PROVIDER_CAPABILITY_UNSUPPORTED: 'PROVIDER_CAPABILITY_UNSUPPORTED',
  PROVIDER_PRICE_CHANGED: 'PROVIDER_PRICE_CHANGED',
  ALLOCATION_EXPIRED: 'ALLOCATION_EXPIRED',
  ALLOCATION_EXHAUSTED: 'ALLOCATION_EXHAUSTED',
  ALLOCATION_SUSPENDED: 'ALLOCATION_SUSPENDED',
  LOCAL_CONFIRMATION_FAILED_AFTER_PROVIDER_CONFIRM:
    'LOCAL_CONFIRMATION_FAILED_AFTER_PROVIDER_CONFIRM',
  COMPENSATION_REQUIRED: 'COMPENSATION_REQUIRED',
  MANUAL_REVIEW_REQUIRED: 'MANUAL_REVIEW_REQUIRED',
} as const;

export type ExternalBookingFailureCode =
  (typeof ExternalBookingFailure)[keyof typeof ExternalBookingFailure];

/** Stable public error codes (safe to return to clients). */
export const ExternalBookingErrorCodes = {
  INVENTORY_UNAVAILABLE: 'BOOKING_INVENTORY_UNAVAILABLE',
  PROVIDER_UNAVAILABLE: 'BOOKING_PROVIDER_UNAVAILABLE',
  RESERVATION_EXPIRED: 'BOOKING_RESERVATION_EXPIRED',
  PRICE_CHANGED: 'BOOKING_PRICE_CHANGED',
  NOT_SUPPORTED: 'BOOKING_NOT_SUPPORTED',
  ALLOCATION_UNAVAILABLE: 'BOOKING_ALLOCATION_UNAVAILABLE',
  PENDING_REVIEW: 'BOOKING_PENDING_REVIEW',
} as const;

interface Mapping {
  code: string;
  message: string;
  status: HttpStatus;
}

/** Map an internal failure classification to a safe, client-appropriate response. */
export function mapExternalBookingFailure(failure: ExternalBookingFailureCode): Mapping {
  switch (failure) {
    case ExternalBookingFailure.PROVIDER_SOLD_OUT:
    case ExternalBookingFailure.ALLOCATION_EXHAUSTED:
      return {
        code: ExternalBookingErrorCodes.INVENTORY_UNAVAILABLE,
        message: 'These tickets are no longer available.',
        status: HttpStatus.CONFLICT,
      };
    case ExternalBookingFailure.PROVIDER_RESERVATION_EXPIRED:
      return {
        code: ExternalBookingErrorCodes.RESERVATION_EXPIRED,
        message: 'Your reservation has expired — please start again.',
        status: HttpStatus.CONFLICT,
      };
    case ExternalBookingFailure.PROVIDER_PRICE_CHANGED:
      return {
        code: ExternalBookingErrorCodes.PRICE_CHANGED,
        message: 'The price changed — please review and try again.',
        status: HttpStatus.CONFLICT,
      };
    case ExternalBookingFailure.PROVIDER_CAPABILITY_UNSUPPORTED:
      return {
        code: ExternalBookingErrorCodes.NOT_SUPPORTED,
        message: 'This booking type is not supported yet.',
        status: HttpStatus.NOT_IMPLEMENTED,
      };
    case ExternalBookingFailure.ALLOCATION_EXPIRED:
    case ExternalBookingFailure.ALLOCATION_SUSPENDED:
      return {
        code: ExternalBookingErrorCodes.ALLOCATION_UNAVAILABLE,
        message: 'These tickets are not currently on sale.',
        status: HttpStatus.CONFLICT,
      };
    case ExternalBookingFailure.PROVIDER_TEMPORARILY_UNAVAILABLE:
    case ExternalBookingFailure.PROVIDER_CIRCUIT_OPEN:
    case ExternalBookingFailure.PROVIDER_MAPPING_MISSING:
    case ExternalBookingFailure.PROVIDER_MAPPING_AMBIGUOUS:
      return {
        code: ExternalBookingErrorCodes.PROVIDER_UNAVAILABLE,
        message: 'Ticketing is temporarily unavailable — please try again shortly.',
        status: HttpStatus.SERVICE_UNAVAILABLE,
      };
    // Ambiguous / post-payment / compensation cases must NOT read as a hard failure to the
    // customer — the booking is pending safe resolution, never falsely confirmed or refunded.
    case ExternalBookingFailure.PROVIDER_CONFIRMATION_AMBIGUOUS:
    case ExternalBookingFailure.LOCAL_CONFIRMATION_FAILED_AFTER_PROVIDER_CONFIRM:
    case ExternalBookingFailure.COMPENSATION_REQUIRED:
    case ExternalBookingFailure.MANUAL_REVIEW_REQUIRED:
    case ExternalBookingFailure.PROVIDER_CONFIRMATION_REJECTED:
    case ExternalBookingFailure.PROVIDER_RESERVATION_REJECTED:
    default:
      return {
        code: ExternalBookingErrorCodes.PENDING_REVIEW,
        message: 'We are finalizing your booking — you will be updated shortly.',
        status: HttpStatus.ACCEPTED,
      };
  }
}

/** Raise a safe, typed exception for a provider/allocation failure classification. */
export class ExternalBookingException extends AppException {
  constructor(
    readonly failure: ExternalBookingFailureCode,
    details: Record<string, unknown> = {},
  ) {
    const m = mapExternalBookingFailure(failure);
    super(m.code, m.message, m.status, { ...details, classification: failure });
  }
}
