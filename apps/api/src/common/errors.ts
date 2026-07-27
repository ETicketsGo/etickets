import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Domain error carrying a stable machine code. The global filter renders it
 * into the standard error envelope (see all-exceptions.filter.ts).
 */
export class AppException extends HttpException {
  constructor(
    readonly code: string,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
    readonly details: Record<string, unknown> = {},
  ) {
    super({ code, message, details }, status);
  }
}

/** Central catalogue of error codes used across the API. */
export const ErrorCodes = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  EMAIL_ALREADY_REGISTERED: 'EMAIL_ALREADY_REGISTERED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  INVALID_REFRESH_TOKEN: 'INVALID_REFRESH_TOKEN',
  TENANT_FORBIDDEN: 'TENANT_FORBIDDEN',
  BOOKING_INVENTORY_UNAVAILABLE: 'BOOKING_INVENTORY_UNAVAILABLE',
  BOOKING_EXPIRED: 'BOOKING_EXPIRED',
  BOOKING_NOT_PAYABLE: 'BOOKING_NOT_PAYABLE',
  PAYMENT_WEBHOOK_INVALID: 'PAYMENT_WEBHOOK_INVALID',
  PAYMENT_PROVIDER_UNAVAILABLE: 'PAYMENT_PROVIDER_UNAVAILABLE',
  INVENTORY_PROVIDER_UNAVAILABLE: 'INVENTORY_PROVIDER_UNAVAILABLE',
  INVENTORY_SOURCE_UNSUPPORTED: 'INVENTORY_SOURCE_UNSUPPORTED',
  QR_INVALID: 'QR_INVALID',
  CHECKIN_DUPLICATE: 'CHECKIN_DUPLICATE',
  REFUND_NOT_ELIGIBLE: 'REFUND_NOT_ELIGIBLE',
  REVIEW_NOT_ELIGIBLE: 'REVIEW_NOT_ELIGIBLE',
  EVENT_NOT_PUBLISHED: 'EVENT_NOT_PUBLISHED',
  MAINTENANCE_MODE: 'MAINTENANCE_MODE',
  INTERNAL: 'INTERNAL',
} as const;
