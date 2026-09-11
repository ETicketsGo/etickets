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
  /*
    ── EXTERNAL INVENTORY AUTHORITIES ─────────────────────────────────────────────
    Four codes, not the fifteen a provider integration is usually specified with. Each
    earns its place by leading somewhere different:

    - ALREADY_HELD vs ALREADY_SOLD is the difference between "wait a few minutes" and
      "these seats are gone"; collapsing them makes the customer-facing message a guess.
    - HOLD_EXPIRED is recoverable by re-taking the seats, which no other conflict is.
    - PROVIDER_TIMEOUT is NOT a failure. It means the outcome is UNKNOWN — the request may
      well have succeeded at the far end — and it is the one case where retrying blindly, or
      refunding blindly, causes the double booking or double refund. It exists so that
      reconciliation can tell "we know it failed" from "we do not know", which
      INVENTORY_PROVIDER_UNAVAILABLE cannot express.

    Everything else a vendor might report (rate limits, auth failures, malformed responses)
    is a provider being unavailable to us, and INVENTORY_PROVIDER_UNAVAILABLE already says
    that. Adding codes nothing branches on only makes the taxonomy harder to use correctly.
  */
  INVENTORY_ALREADY_HELD: 'INVENTORY_ALREADY_HELD',
  INVENTORY_ALREADY_SOLD: 'INVENTORY_ALREADY_SOLD',
  HOLD_EXPIRED: 'HOLD_EXPIRED',
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
  QR_INVALID: 'QR_INVALID',
  CHECKIN_DUPLICATE: 'CHECKIN_DUPLICATE',
  REFUND_NOT_ELIGIBLE: 'REFUND_NOT_ELIGIBLE',
  REVIEW_NOT_ELIGIBLE: 'REVIEW_NOT_ELIGIBLE',
  EVENT_NOT_PUBLISHED: 'EVENT_NOT_PUBLISHED',
  /**
   * A film that is missing, DRAFT or ARCHIVED. Deliberately one code for all three: a
   * distinct "exists but unpublished" would leak the catalogue pipeline to anyone
   * guessing slugs.
   */
  MOVIE_NOT_PUBLISHED: 'MOVIE_NOT_PUBLISHED',
  /** Deletion refused for a reason the user can act on (e.g. sole organization owner). */
  ACCOUNT_DELETION_BLOCKED: 'ACCOUNT_DELETION_BLOCKED',
  /** The caller is asking too often — used where the cost of a request is somebody else's. */
  ORGANIZATION_LIMIT_REACHED: 'ORGANIZATION_LIMIT_REACHED',
  RATE_LIMITED: 'RATE_LIMITED',
  MAINTENANCE_MODE: 'MAINTENANCE_MODE',
  INTERNAL: 'INTERNAL',
} as const;
