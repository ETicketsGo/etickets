/**
 * Provider-neutral booking orchestration state machine (ADR-042, P5).
 *
 * These are the ORCHESTRATOR's internal workflow states — distinct from the
 * customer-visible `BookingStatus` (PENDING_PAYMENT/CONFIRMED/…), which is unchanged.
 * The orchestrator maps its workflow onto `BookingStatus` at key milestones; every
 * transition here is explicit, validated, idempotent, and driven only through the
 * orchestrator. No state transition occurs outside it.
 */
export const BookingWorkflowState = {
  DRAFT: 'DRAFT',
  INVENTORY_RESOLVED: 'INVENTORY_RESOLVED',
  LOCK_PENDING: 'LOCK_PENDING',
  LOCKED: 'LOCKED',
  // Provider-authoritative reservation (P5.2B Slice 3): a temporary hold on the external
  // provider's inventory, created before payment and confirmed after it.
  PROVIDER_RESERVATION_PENDING: 'PROVIDER_RESERVATION_PENDING',
  PROVIDER_RESERVED: 'PROVIDER_RESERVED',
  PAYMENT_PENDING: 'PAYMENT_PENDING',
  PAYMENT_AUTHORIZED: 'PAYMENT_AUTHORIZED',
  PROVIDER_CONFIRM_PENDING: 'PROVIDER_CONFIRM_PENDING',
  PROVIDER_CONFIRMED: 'PROVIDER_CONFIRMED',
  CONFIRMING: 'CONFIRMING',
  CONFIRMED: 'CONFIRMED',
  TICKET_PENDING: 'TICKET_PENDING',
  TICKET_ISSUED: 'TICKET_ISSUED',
  CANCELLATION_PENDING: 'CANCELLATION_PENDING',
  CANCELLED: 'CANCELLED',
  REFUND_PENDING: 'REFUND_PENDING',
  REFUNDED: 'REFUNDED',
  EXPIRING: 'EXPIRING',
  EXPIRED: 'EXPIRED',
  COMPENSATION_PENDING: 'COMPENSATION_PENDING',
  COMPENSATED: 'COMPENSATED',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  FAILED: 'FAILED',
} as const;

export type BookingWorkflowState = (typeof BookingWorkflowState)[keyof typeof BookingWorkflowState];

/**
 * Terminal states — no outgoing transitions. TICKET_ISSUED is NOT terminal: a booked +
 * ticketed booking may still enter cancellation/refund (post-sale), which those flows model.
 */
export const TERMINAL_STATES: ReadonlySet<BookingWorkflowState> = new Set([
  BookingWorkflowState.CANCELLED,
  BookingWorkflowState.REFUNDED,
  BookingWorkflowState.EXPIRED,
  BookingWorkflowState.COMPENSATED,
  BookingWorkflowState.FAILED,
]);

/** States from which compensation may be initiated (money/inventory/provider may be dirty). */
export const COMPENSATABLE_STATES: ReadonlySet<BookingWorkflowState> = new Set([
  BookingWorkflowState.LOCKED,
  BookingWorkflowState.PROVIDER_RESERVATION_PENDING,
  BookingWorkflowState.PROVIDER_RESERVED,
  BookingWorkflowState.PAYMENT_PENDING,
  BookingWorkflowState.PAYMENT_AUTHORIZED,
  BookingWorkflowState.PROVIDER_CONFIRM_PENDING,
  BookingWorkflowState.PROVIDER_CONFIRMED,
  BookingWorkflowState.CONFIRMING,
]);

export function isTerminal(state: BookingWorkflowState): boolean {
  return TERMINAL_STATES.has(state);
}
