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
  /** Back-office session that has not passed (or has not enrolled) the second factor. */
  MFA_REQUIRED: 'MFA_REQUIRED',
  /** A sensitive action needs a second-factor check newer than the session has. */
  MFA_STEP_UP_REQUIRED: 'MFA_STEP_UP_REQUIRED',
  /**
   * MFA_ENROLLMENT=deferred: a sensitive action by staff who have not set up an authenticator
   * yet. They can, from the same session; the console sends them to do it.
   */
  MFA_SETUP_REQUIRED: 'MFA_SETUP_REQUIRED',
  /**
   * A sensitive action on a server with no MFA_ENCRYPTION_KEY: no authenticator can exist, so
   * the action is blocked (never skipped) until an operator configures MFA.
   */
  MFA_NOT_CONFIGURED: 'MFA_NOT_CONFIGURED',
  MFA_INVALID_CODE: 'MFA_INVALID_CODE',
  MFA_LOCKED: 'MFA_LOCKED',
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
  /**
   * An offline check-in device that is not ACTIVE (pending, suspended, revoked or expired) asked
   * for a ticket list or uploaded scans. Its own code so the door app can say which, and stop
   * admitting, instead of reading it as any other refusal.
   */
  DEVICE_NOT_ACTIVE: 'DEVICE_NOT_ACTIVE',
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
  /**
   * Tax where this sale happens depends on what the ticket is, and the ticket (and its event)
   * carry no tax classification. Refused rather than taxed at an assumed rate; the organizer
   * sets the classification on the event.
   */
  TAX_CLASSIFICATION_MISSING: 'TAX_CLASSIFICATION_MISSING',
  /** The ticket is classified, but no active tax rule covers that classification and price. */
  TAX_RULE_NOT_FOUND: 'TAX_RULE_NOT_FOUND',
  /**
   * A text message cannot be delivered to this number: it is not a reachable mobile, or its
   * owner has opted out. Deliberately one code for both, so it cannot be used to learn which.
   */
  SMS_UNDELIVERABLE: 'SMS_UNDELIVERABLE',
  /** Text messaging is not working right now. Says nothing about which provider or why. */
  SMS_UNAVAILABLE: 'SMS_UNAVAILABLE',
  /** Email cannot be sent right now (no real provider, or it refused). Same rule as SMS. */
  EMAIL_UNAVAILABLE: 'EMAIL_UNAVAILABLE',
  /**
   * A payout's allocations did not add up to the payout. Our own ledger disagreed with itself,
   * so no payout was written.
   *
   * Deliberately its own code rather than INTERNAL: it means something specific and it leads
   * somewhere specific - stop the payout run and reconcile - which a generic internal error
   * does not. It is never the caller's fault and never retryable by them.
   */
  PAYOUT_ALLOCATION_MISMATCH: 'PAYOUT_ALLOCATION_MISMATCH',
  MAINTENANCE_MODE: 'MAINTENANCE_MODE',
  /**
   * The human check (Cloudflare Turnstile, see src/human-check). REQUIRED (428): send the
   * request again with a solved token. FAILED (403): the token proved nothing; solve again.
   * UNAVAILABLE (503): Cloudflare could not answer and this route fails closed.
   */
  HUMAN_CHECK_REQUIRED: 'HUMAN_CHECK_REQUIRED',
  HUMAN_CHECK_FAILED: 'HUMAN_CHECK_FAILED',
  HUMAN_CHECK_UNAVAILABLE: 'HUMAN_CHECK_UNAVAILABLE',
  INTERNAL: 'INTERNAL',
} as const;
