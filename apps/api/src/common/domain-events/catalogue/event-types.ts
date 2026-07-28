/**
 * The canonical registry of domain event type names and their CURRENT schema
 * versions (ADR-038). Event names are stable, dotted business facts. Versions start
 * at 1 and are bumped ONLY for a breaking payload change — additive optional fields
 * do not bump the version. See docs/adr/ADR-038 + docs/architecture/EVENT-CATALOGUE.
 *
 * Typed payloads + builders exist for the core booking/inventory lifecycle (the other
 * names are reserved here so producers/consumers share one vocabulary as later slices
 * add their payloads).
 */
export const DomainEventType = {
  InventoryLocked: 'inventory.locked',
  InventoryReleased: 'inventory.released',
  BookingPaymentPending: 'booking.payment_pending',
  BookingConfirmed: 'booking.confirmed',
  BookingCancelled: 'booking.cancelled',
  BookingExpired: 'booking.expired',
  RefundRequested: 'refund.requested',
  RefundProcessed: 'refund.processed',
  TicketGenerated: 'ticket.generated',
  TicketCheckedIn: 'ticket.checked_in',
  SettlementCompleted: 'settlement.completed',
  NotificationRequested: 'notification.requested',
  ProviderHealthChanged: 'provider.health_changed',
  InventorySyncRequested: 'inventory.sync_requested',
  InventorySyncStarted: 'inventory.sync_started',
  InventorySyncCompleted: 'inventory.sync_completed',
  InventorySyncFailed: 'inventory.sync_failed',
  ExperienceUpdated: 'experience.updated',
  SessionUpdated: 'session.updated',
  SessionCancelled: 'session.cancelled',
  PricingUpdated: 'pricing.updated',
  SeatAvailabilityUpdated: 'seat_availability.updated',
  QuantityAvailabilityUpdated: 'quantity_availability.updated',
  ProviderMappingReviewRequired: 'provider.mapping_review_required',

  // ── Provider-authoritative booking lifecycle (ADR-042 P5.3A) ──
  BookingProviderReservationCreated: 'booking.provider_reservation_created',
  BookingProviderReservationRejected: 'booking.provider_reservation_rejected',
  BookingProviderReservationExpired: 'booking.provider_reservation_expired',
  BookingProviderConfirmationRequested: 'booking.provider_confirmation_requested',
  BookingProviderConfirmed: 'booking.provider_confirmed',
  BookingProviderConfirmationAmbiguous: 'booking.provider_confirmation_ambiguous',
  BookingProviderStatusRecoveryRequested: 'booking.provider_status_recovery_requested',
  BookingProviderStatusRecovered: 'booking.provider_status_recovered',
  BookingProviderCancellationRequested: 'booking.provider_cancellation_requested',
  BookingProviderCancelled: 'booking.provider_cancelled',
  // ── Allocated inventory lifecycle (ADR-042 P5.3A) ──
  BookingAllocationValidated: 'booking.allocation_validated',
  BookingAllocationRejected: 'booking.allocation_rejected',
  BookingAllocationConsumptionHeld: 'booking.allocation_consumption_held',
  BookingAllocationConsumptionConfirmed: 'booking.allocation_consumption_confirmed',
  BookingAllocationConsumptionReleased: 'booking.allocation_consumption_released',
  BookingAllocationReconciliationRequired: 'booking.allocation_reconciliation_required',
  // ── Compensation lifecycle (ADR-043 P5.3A) ──
  BookingCompensationRequired: 'booking.compensation_required',
  BookingCompensationPlanned: 'booking.compensation_planned',
  BookingCompensationStarted: 'booking.compensation_started',
  BookingCompensationCompleted: 'booking.compensation_completed',
  BookingCompensationRetryScheduled: 'booking.compensation_retry_scheduled',
  BookingCompensationFailed: 'booking.compensation_failed',
  BookingCompensationDeadLettered: 'booking.compensation_dead_lettered',
  BookingManualReviewRequired: 'booking.manual_review_required',
  // ── Payment void lifecycle (ADR-043 P5.3B Phase 5) ──
  BookingPaymentVoidRequested: 'booking.payment_void_requested',
  BookingPaymentVoided: 'booking.payment_voided',
  BookingPaymentVoidAmbiguous: 'booking.payment_void_ambiguous',
  BookingPaymentVoidRejected: 'booking.payment_void_rejected',
  BookingPaymentStatusRecoveryRequested: 'booking.payment_status_recovery_requested',
  BookingPaymentStatusRecovered: 'booking.payment_status_recovered',
} as const;

export type DomainEventTypeName = (typeof DomainEventType)[keyof typeof DomainEventType];

/** Current schema version per event type. All start at 1 (see evolution rule above). */
export const DomainEventVersion: Record<DomainEventTypeName, number> = {
  [DomainEventType.InventoryLocked]: 1,
  [DomainEventType.InventoryReleased]: 1,
  [DomainEventType.BookingPaymentPending]: 1,
  [DomainEventType.BookingConfirmed]: 1,
  [DomainEventType.BookingCancelled]: 1,
  [DomainEventType.BookingExpired]: 1,
  [DomainEventType.RefundRequested]: 1,
  [DomainEventType.RefundProcessed]: 1,
  [DomainEventType.TicketGenerated]: 1,
  [DomainEventType.TicketCheckedIn]: 1,
  [DomainEventType.SettlementCompleted]: 1,
  [DomainEventType.NotificationRequested]: 1,
  [DomainEventType.ProviderHealthChanged]: 1,
  [DomainEventType.InventorySyncRequested]: 1,
  [DomainEventType.InventorySyncStarted]: 1,
  [DomainEventType.InventorySyncCompleted]: 1,
  [DomainEventType.InventorySyncFailed]: 1,
  [DomainEventType.ExperienceUpdated]: 1,
  [DomainEventType.SessionUpdated]: 1,
  [DomainEventType.SessionCancelled]: 1,
  [DomainEventType.PricingUpdated]: 1,
  [DomainEventType.SeatAvailabilityUpdated]: 1,
  [DomainEventType.QuantityAvailabilityUpdated]: 1,
  [DomainEventType.ProviderMappingReviewRequired]: 1,
  [DomainEventType.BookingProviderReservationCreated]: 1,
  [DomainEventType.BookingProviderReservationRejected]: 1,
  [DomainEventType.BookingProviderReservationExpired]: 1,
  [DomainEventType.BookingProviderConfirmationRequested]: 1,
  [DomainEventType.BookingProviderConfirmed]: 1,
  [DomainEventType.BookingProviderConfirmationAmbiguous]: 1,
  [DomainEventType.BookingProviderStatusRecoveryRequested]: 1,
  [DomainEventType.BookingProviderStatusRecovered]: 1,
  [DomainEventType.BookingProviderCancellationRequested]: 1,
  [DomainEventType.BookingProviderCancelled]: 1,
  [DomainEventType.BookingAllocationValidated]: 1,
  [DomainEventType.BookingAllocationRejected]: 1,
  [DomainEventType.BookingAllocationConsumptionHeld]: 1,
  [DomainEventType.BookingAllocationConsumptionConfirmed]: 1,
  [DomainEventType.BookingAllocationConsumptionReleased]: 1,
  [DomainEventType.BookingAllocationReconciliationRequired]: 1,
  [DomainEventType.BookingCompensationRequired]: 1,
  [DomainEventType.BookingCompensationPlanned]: 1,
  [DomainEventType.BookingCompensationStarted]: 1,
  [DomainEventType.BookingCompensationCompleted]: 1,
  [DomainEventType.BookingCompensationRetryScheduled]: 1,
  [DomainEventType.BookingCompensationFailed]: 1,
  [DomainEventType.BookingCompensationDeadLettered]: 1,
  [DomainEventType.BookingManualReviewRequired]: 1,
  [DomainEventType.BookingPaymentVoidRequested]: 1,
  [DomainEventType.BookingPaymentVoided]: 1,
  [DomainEventType.BookingPaymentVoidAmbiguous]: 1,
  [DomainEventType.BookingPaymentVoidRejected]: 1,
  [DomainEventType.BookingPaymentStatusRecoveryRequested]: 1,
  [DomainEventType.BookingPaymentStatusRecovered]: 1,
};

/** Envelope fields a producer may attach to any catalogue event (all optional). */
export interface EventTracing {
  correlationId?: string;
  causationId?: string;
  actorId?: string;
  tenantId?: string;
  metadata?: Record<string, unknown>;
}
