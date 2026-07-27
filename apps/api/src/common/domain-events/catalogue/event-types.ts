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
  InventorySyncCompleted: 'inventory.sync_completed',
  InventorySyncFailed: 'inventory.sync_failed',
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
  [DomainEventType.InventorySyncCompleted]: 1,
  [DomainEventType.InventorySyncFailed]: 1,
};

/** Envelope fields a producer may attach to any catalogue event (all optional). */
export interface EventTracing {
  correlationId?: string;
  causationId?: string;
  actorId?: string;
  tenantId?: string;
  metadata?: Record<string, unknown>;
}
