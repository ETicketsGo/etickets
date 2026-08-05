/**
 * Provider-neutral EXTERNAL BOOKING seam (ADR-042 §6, P5.2B). This is deliberately SEPARATE
 * from the P1 `InventoryProvider` (sourcing/availability), the P4 `InventorySyncProvider`
 * (bulk state ingestion), and the payment providers. It models the remote booking LIFECYCLE
 * — reserve → confirm → cancel → status → refund — for PROVIDER_AUTHORITATIVE inventory,
 * where an external system owns the final inventory truth. Adapters never touch payment
 * routing, local inventory, or ticket issuance; the orchestrator composes those seams.
 *
 * All calls are capability-gated (see `ExternalBookingProviderCapabilities`) and carry a
 * stable idempotency key so a retried or duplicated call never creates a second reservation
 * or confirmation. Results are summarized, PII-free, and never contain provider secrets or
 * raw response bodies.
 */

/** How a provider call resolved, normalized so the orchestrator can branch safely. */
export type ExternalBookingOutcome =
  | 'OK'
  | 'SOLD_OUT'
  | 'RESERVATION_EXPIRED'
  | 'REJECTED'
  | 'RETRYABLE'
  | 'AMBIGUOUS' // timeout / lost response — status unknown, must NOT be read as failure
  | 'NOT_FOUND'
  | 'CONFLICT';

export interface ExternalBookingProviderCapabilities {
  readonly supportsAvailabilityCheck: boolean;
  readonly supportsTemporaryReservation: boolean;
  readonly supportsReservationRenewal: boolean;
  readonly supportsConfirm: boolean;
  readonly supportsCancel: boolean;
  readonly supportsStatusQuery: boolean;
  readonly supportsRefund: boolean;
  readonly requiresPaymentBeforeReservation: boolean;
  readonly requiresPaymentBeforeConfirmation: boolean;
  readonly supportsAuthorizeThenCapture: boolean;
  readonly reservationTtlSeconds?: number;
  readonly idempotentReservation: boolean;
  readonly idempotentConfirmation: boolean;
  readonly idempotentCancellation: boolean;
}

/** A unit of external inventory to reserve — seat ids (reserved seating) or a quantity (GA). */
export interface ExternalInventorySelection {
  inventoryType: 'SEAT' | 'QUANTITY';
  seatRefs?: string[];
  quantity?: number;
}

export interface ExternalAvailabilityRequest {
  providerInventoryRef: string;
  selection: ExternalInventorySelection;
  correlationId?: string;
}
export interface ExternalAvailabilityResult {
  outcome: ExternalBookingOutcome;
  available: boolean;
}

export interface ExternalReservationRequest {
  providerInventoryRef: string;
  selection: ExternalInventorySelection;
  /** Stable per-workflow key — a retry/duplicate must return the SAME reservation. */
  idempotencyKey: string;
  /** Server-computed authoritative amount for cross-checking against the provider price. */
  expectedAmountMinor?: number;
  currency?: string;
  correlationId?: string;
}
export interface ExternalReservationResult {
  outcome: ExternalBookingOutcome;
  providerReservationId?: string;
  reservationExpiresAt?: Date;
  /** Provider-quoted amount, if returned, for price-consistency validation. */
  amountMinor?: number;
  currency?: string;
  providerStatus?: string;
}

export interface ExternalConfirmationRequest {
  providerReservationId: string;
  idempotencyKey: string;
  correlationId?: string;
}
export interface ExternalConfirmationResult {
  outcome: ExternalBookingOutcome;
  providerBookingId?: string;
  providerStatus?: string;
}

export interface ExternalCancellationRequest {
  providerReservationId?: string;
  providerBookingId?: string;
  idempotencyKey: string;
  correlationId?: string;
}
export interface ExternalCancellationResult {
  outcome: ExternalBookingOutcome;
  providerStatus?: string;
}

export interface ExternalBookingStatusRequest {
  providerReservationId?: string;
  providerBookingId?: string;
  idempotencyKey: string;
  correlationId?: string;
}
export interface ExternalBookingStatusResult {
  outcome: ExternalBookingOutcome;
  /** Normalized lifecycle position as the provider currently reports it. */
  status: 'RESERVED' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED' | 'REJECTED' | 'UNKNOWN';
  providerBookingId?: string;
}

export interface ExternalRefundRequest {
  providerBookingId: string;
  amountMinor: number;
  idempotencyKey: string;
  correlationId?: string;
}
export interface ExternalRefundResult {
  outcome: ExternalBookingOutcome;
  providerRefundId?: string;
}

export interface ExternalBookingProviderHealth {
  healthy: boolean;
  detail?: string;
}

export interface ExternalBookingProvider {
  readonly providerCode: string;
  capabilities(): ExternalBookingProviderCapabilities;
  checkAvailability(request: ExternalAvailabilityRequest): Promise<ExternalAvailabilityResult>;
  createReservation(request: ExternalReservationRequest): Promise<ExternalReservationResult>;
  confirmReservation(request: ExternalConfirmationRequest): Promise<ExternalConfirmationResult>;
  cancelReservation(request: ExternalCancellationRequest): Promise<ExternalCancellationResult>;
  getBookingStatus(request: ExternalBookingStatusRequest): Promise<ExternalBookingStatusResult>;
  refundBooking?(request: ExternalRefundRequest): Promise<ExternalRefundResult>;
  health(): Promise<ExternalBookingProviderHealth>;
}

/** DI token for the (optional) set of registered external booking providers. */
export const EXTERNAL_BOOKING_PROVIDERS = Symbol('EXTERNAL_BOOKING_PROVIDERS');
