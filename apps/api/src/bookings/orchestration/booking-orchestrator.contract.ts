import type { InventoryOwnershipMode } from '../../inventory/sync/contracts/canonical-change';
import type { BookingWorkflowState } from './booking-workflow-state';
import type { ResolvedOwner } from './booking-owner';

/**
 * The single provider-neutral booking orchestration contract (ADR-042). Controllers and
 * payment webhooks invoke THIS — they never reproduce workflow decisions. Domain services
 * (BookingsService, PaymentsService, InventoryStrategy, InventoryLockService, providers,
 * outbox) remain focused on their own mutations; the orchestrator composes them.
 */

export interface LockOwnerRef {
  ownerId?: string;
  anonymousSessionId?: string;
}

export interface InitiateBookingRequest {
  eventSessionId: string;
  items: Array<{ ticketTypeId: string; quantity: number; seatIds?: string[] }>;
  owner: LockOwnerRef;
  /** Server-decided durable owner (ADR-042 §4). Persisted on the workflow at creation. */
  requestOwner?: ResolvedOwner;
  /** Tenant/organizer scope captured for isolation checks. */
  tenantId?: string;
  organizerId?: string;
  buyerName?: string;
  buyerEmail?: string;
  couponCode?: string;
  /** Same key + same normalized request ⇒ the same booking (idempotent). */
  idempotencyKey: string;
  correlationId?: string;
}

export interface BeginBookingPaymentRequest {
  bookingId: string;
  owner: LockOwnerRef;
  /** Server-decided owner validated against the workflow's durable owner. */
  requestOwner?: ResolvedOwner;
  idempotencyKey: string;
  correlationId?: string;
}

export interface ConfirmBookingPaymentRequest {
  /** Provider-verified payment event (from the payment webhook), never client-trusted. */
  bookingId: string;
  providerRef: string;
  amountMinor: number;
  correlationId?: string;
}

export interface CancelBookingRequest {
  bookingId: string;
  owner: LockOwnerRef;
  /** Server-decided owner validated against the workflow's durable owner. */
  requestOwner?: ResolvedOwner;
  reason?: string;
  correlationId?: string;
}

export interface ExpireBookingRequest {
  bookingId: string;
  correlationId?: string;
}

export interface RetryBookingWorkflowRequest {
  bookingId: string;
  /** Privileged (ops) retry bypasses owner checks; audited. */
  internal?: boolean;
  correlationId?: string;
}

export interface ReconcileBookingRequest {
  bookingId?: string;
  limit?: number;
}

export interface BookingOrchestrationResult {
  bookingId: string;
  workflowState: BookingWorkflowState;
  ownershipMode: InventoryOwnershipMode;
  selectedProviderCode?: string;
}

export interface BookingPaymentResult {
  bookingId: string;
  workflowState: BookingWorkflowState;
  /** Client-safe payment action (redirect/clientSecret/order) from the payment provider. */
  payment: unknown;
}

export interface BookingConfirmationResult {
  bookingId: string;
  workflowState: BookingWorkflowState;
  confirmed: boolean;
  ticketsIssued?: number;
}

export interface BookingCancellationResult {
  bookingId: string;
  workflowState: BookingWorkflowState;
  refundPending: boolean;
}

export interface BookingExpirationResult {
  bookingId: string;
  workflowState: BookingWorkflowState;
}

export interface BookingReconciliationResult {
  scanned: number;
  mismatches: Array<{ bookingId: string; classification: string; detail: string }>;
}

export interface BookingOrchestrator {
  initiate(request: InitiateBookingRequest): Promise<BookingOrchestrationResult>;
  beginPayment(request: BeginBookingPaymentRequest): Promise<BookingPaymentResult>;
  confirmPayment(request: ConfirmBookingPaymentRequest): Promise<BookingConfirmationResult>;
  cancel(request: CancelBookingRequest): Promise<BookingCancellationResult>;
  expire(request: ExpireBookingRequest): Promise<BookingExpirationResult>;
  retry(request: RetryBookingWorkflowRequest): Promise<BookingOrchestrationResult>;
  reconcile(request: ReconcileBookingRequest): Promise<BookingReconciliationResult>;
}

export const BOOKING_ORCHESTRATOR = Symbol('BOOKING_ORCHESTRATOR');
