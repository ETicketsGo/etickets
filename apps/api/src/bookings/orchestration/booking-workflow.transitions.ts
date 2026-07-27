import { BookingWorkflowState as S, isTerminal } from './booking-workflow-state';
import { InvalidBookingTransitionError } from './booking-orchestrator.errors';

/**
 * The booking-orchestration transition matrix (ADR-042). Maps each state to the set of
 * states it may move to. Every transition the orchestrator performs is validated against
 * this table; invalid transitions are rejected visibly. Terminal states have no outgoing
 * transitions. See BOOKING-STATE-TRANSITION-MATRIX.md for preconditions / side effects /
 * events / compensation per transition.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<S, ReadonlySet<S>>> = {
  [S.DRAFT]: new Set([S.INVENTORY_RESOLVED, S.FAILED, S.EXPIRED]),
  [S.INVENTORY_RESOLVED]: new Set([S.LOCK_PENDING, S.FAILED, S.EXPIRED]),
  [S.LOCK_PENDING]: new Set([S.LOCKED, S.FAILED, S.EXPIRED, S.COMPENSATION_PENDING]),
  [S.LOCKED]: new Set([
    S.PAYMENT_PENDING,
    S.EXPIRING,
    S.CANCELLATION_PENDING,
    S.COMPENSATION_PENDING,
    S.FAILED,
  ]),
  [S.PAYMENT_PENDING]: new Set([
    S.PAYMENT_AUTHORIZED,
    S.CONFIRMING, // immediate-capture providers skip the AUTHORIZED step
    S.EXPIRING,
    S.CANCELLATION_PENDING,
    S.COMPENSATION_PENDING,
    S.FAILED,
  ]),
  [S.PAYMENT_AUTHORIZED]: new Set([
    S.PROVIDER_CONFIRM_PENDING, // provider-authoritative inventory
    S.CONFIRMING, // local/allocated inventory
    S.CANCELLATION_PENDING,
    S.COMPENSATION_PENDING,
    S.FAILED,
  ]),
  [S.PROVIDER_CONFIRM_PENDING]: new Set([
    S.PROVIDER_CONFIRMED,
    S.COMPENSATION_PENDING,
    S.MANUAL_REVIEW,
    S.FAILED,
  ]),
  [S.PROVIDER_CONFIRMED]: new Set([S.CONFIRMING, S.COMPENSATION_PENDING, S.FAILED]),
  [S.CONFIRMING]: new Set([S.CONFIRMED, S.COMPENSATION_PENDING, S.MANUAL_REVIEW, S.FAILED]),
  [S.CONFIRMED]: new Set([S.TICKET_PENDING, S.CANCELLATION_PENDING, S.REFUND_PENDING]),
  [S.TICKET_PENDING]: new Set([S.TICKET_ISSUED, S.MANUAL_REVIEW]),
  // Booked + ticketed: stable success, but post-sale cancel/refund may still occur.
  [S.TICKET_ISSUED]: new Set([S.CANCELLATION_PENDING, S.REFUND_PENDING]),
  [S.CANCELLATION_PENDING]: new Set([
    S.CANCELLED,
    S.REFUND_PENDING, // paid booking → refund path
    S.COMPENSATION_PENDING,
    S.MANUAL_REVIEW,
  ]),
  [S.REFUND_PENDING]: new Set([S.REFUNDED, S.COMPENSATION_PENDING, S.MANUAL_REVIEW]),
  [S.EXPIRING]: new Set([S.EXPIRED, S.COMPENSATION_PENDING, S.MANUAL_REVIEW]),
  [S.COMPENSATION_PENDING]: new Set([S.COMPENSATED, S.MANUAL_REVIEW, S.FAILED]),
  // Operator-driven exits from review (all audited + RBAC-guarded).
  [S.MANUAL_REVIEW]: new Set([
    S.COMPENSATION_PENDING,
    S.CANCELLATION_PENDING,
    S.REFUND_PENDING,
    S.CONFIRMING,
    S.CANCELLED,
    S.FAILED,
  ]),
  // Terminal states — no outgoing transitions.
  [S.CANCELLED]: new Set<S>(),
  [S.REFUNDED]: new Set<S>(),
  [S.EXPIRED]: new Set<S>(),
  [S.COMPENSATED]: new Set<S>(),
  [S.FAILED]: new Set<S>(),
};

/** Whether `to` is a legal next state from `from`. */
export function canTransition(from: S, to: S): boolean {
  if (from === to) return true; // idempotent re-assertion of the current state is a no-op
  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
}

/** Assert a legal transition; throws {@link InvalidBookingTransitionError} otherwise. */
export function assertTransition(from: S, to: S): void {
  if (from === to) return;
  if (isTerminal(from) || !canTransition(from, to)) {
    throw new InvalidBookingTransitionError(from, to);
  }
}
