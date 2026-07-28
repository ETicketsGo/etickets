import { BookingWorkflowState as WS } from './booking-workflow-state';

/**
 * Public, customer-facing booking status vocabulary (ADR-042 §11). The internal workflow
 * has 22 states; the customer only ever sees this stable, small set — identical to what the
 * existing API already exposes via `BookingStatus`, plus `ACTION_REQUIRED` for the manual
 * paths. Internal states (COMPENSATION_PENDING / PROVIDER_CONFIRM_PENDING / MANUAL_REVIEW)
 * are NEVER leaked, and a manual-review workflow never appears confirmed.
 */
export type PublicBookingStatus =
  | 'PENDING'
  | 'CONFIRMED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'REFUND_PENDING'
  | 'REFUNDED'
  | 'ACTION_REQUIRED';

/**
 * Map an internal workflow state to the public status. This is observability/derivation
 * only — the authoritative customer status remains `Booking.status`; active mode does not
 * change that column's meaning. The mapping guarantees no confirmed-looking output for
 * states that are not truly confirmed.
 */
export function toPublicBookingStatus(state: WS): PublicBookingStatus {
  switch (state) {
    case WS.CONFIRMED:
    case WS.TICKET_PENDING:
    case WS.TICKET_ISSUED:
      return 'CONFIRMED';
    case WS.CANCELLATION_PENDING:
    case WS.CANCELLED:
      return 'CANCELLED';
    case WS.EXPIRING:
    case WS.EXPIRED:
      return 'EXPIRED';
    case WS.REFUND_PENDING:
      return 'REFUND_PENDING';
    case WS.REFUNDED:
      return 'REFUNDED';
    // Anything requiring human/operator attention surfaces as a neutral, non-confirmed
    // "action required" — never CONFIRMED, never an internal label.
    case WS.MANUAL_REVIEW:
    case WS.COMPENSATION_PENDING:
    case WS.COMPENSATED:
    case WS.FAILED:
      return 'ACTION_REQUIRED';
    // Everything still in flight toward a decision is simply pending to the customer —
    // including every provider-authoritative reservation/confirmation step. The customer
    // never sees CONFIRMED until the local confirmation transaction commits.
    case WS.DRAFT:
    case WS.INVENTORY_RESOLVED:
    case WS.LOCK_PENDING:
    case WS.LOCKED:
    case WS.PROVIDER_RESERVATION_PENDING:
    case WS.PROVIDER_RESERVED:
    case WS.PAYMENT_PENDING:
    case WS.PAYMENT_AUTHORIZED:
    case WS.PROVIDER_CONFIRM_PENDING:
    case WS.PROVIDER_CONFIRMED:
    case WS.CONFIRMING:
    default:
      return 'PENDING';
  }
}
