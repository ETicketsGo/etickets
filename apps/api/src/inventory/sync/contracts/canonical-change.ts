/**
 * The canonical ETicketsGo inventory-change vocabulary (ADR-040). Provider adapters
 * translate their vendor-specific payloads INTO these stable DTOs; core domain
 * services depend only on this vocabulary, never on any provider schema. Payloads
 * carry identifiers, amounts (minor units), counts and normalized enums — never raw
 * provider payloads, customer names/emails, or secrets.
 */

export type ExternalEntityType =
  | 'EXPERIENCE'
  | 'VENUE'
  | 'SCREEN'
  | 'SEAT_LAYOUT'
  | 'SESSION'
  | 'PRICING'
  | 'SEAT_AVAILABILITY'
  | 'QUANTITY_AVAILABILITY'
  | 'BOOKING'
  | 'REFUND';

export type CanonicalSessionStatus =
  'SCHEDULED' | 'ON_SALE' | 'SUSPENDED' | 'CANCELLED' | 'COMPLETED';

/** Provider-reported seat state (advisory unless the provider owns allocation). */
export type CanonicalSeatState = 'AVAILABLE' | 'HELD' | 'SOLD' | 'BLOCKED';

export type CanonicalBookingStatus =
  'CONFIRMED' | 'CANCELLED' | 'NO_SHOW' | 'CHECKED_IN' | 'UNKNOWN';

export type CanonicalRefundStatus = 'REQUESTED' | 'PROCESSED' | 'FAILED' | 'DECLINED';

/** Fields every canonical change carries for ordering + mapping resolution. */
export interface CanonicalChangeBase {
  externalEntityType: ExternalEntityType;
  /** Stable provider id for the entity (never a display label). */
  externalEntityId: string;
  /** Provider-owned monotonic version/sequence, when available. */
  externalVersion?: number;
  /** ISO-8601 instant the change occurred at the provider (ordering fallback). */
  providerOccurredAt?: string;
  providerTenantId?: string;
}

export interface UpsertExperienceChange extends CanonicalChangeBase {
  kind: 'UPSERT_EXPERIENCE';
  externalEntityType: 'EXPERIENCE';
  title: string;
  experienceType?: string;
  language?: string;
  format?: string;
  durationMinutes?: number;
}

export interface UpsertVenueChange extends CanonicalChangeBase {
  kind: 'UPSERT_VENUE';
  externalEntityType: 'VENUE';
  name: string;
  city?: string;
  country?: string;
  timezone?: string;
}

export interface UpsertScreenChange extends CanonicalChangeBase {
  kind: 'UPSERT_SCREEN';
  externalEntityType: 'SCREEN';
  externalVenueId: string;
  name: string;
  capacity?: number;
}

export interface UpsertSeatLayoutChange extends CanonicalChangeBase {
  kind: 'UPSERT_SEAT_LAYOUT';
  externalEntityType: 'SEAT_LAYOUT';
  externalScreenId: string;
  /** Opaque provider layout version — a change here signals layout drift. */
  layoutVersion: string;
  seatCount: number;
}

export interface UpsertSessionChange extends CanonicalChangeBase {
  kind: 'UPSERT_SESSION';
  externalEntityType: 'SESSION';
  externalExperienceId: string;
  externalVenueId: string;
  externalScreenId?: string;
  startsAt: string; // ISO-8601
  timezone?: string;
  status: CanonicalSessionStatus;
}

export interface UpdatePricingChange extends CanonicalChangeBase {
  kind: 'UPDATE_PRICING';
  externalEntityType: 'PRICING';
  externalSessionId: string;
  /** Minor units + ISO-4217 — value/precision preserved exactly, never converted. */
  tiers: Array<{ code: string; amountMinor: number; currency: string }>;
}

export interface UpdateSeatAvailabilityChange extends CanonicalChangeBase {
  kind: 'UPDATE_SEAT_AVAILABILITY';
  externalEntityType: 'SEAT_AVAILABILITY';
  externalSessionId: string;
  layoutVersion: string;
  /** Stable provider seat ids (never display labels) + normalized states. */
  seats: Array<{ externalSeatId: string; state: CanonicalSeatState }>;
}

export interface UpdateQuantityAvailabilityChange extends CanonicalChangeBase {
  kind: 'UPDATE_QUANTITY_AVAILABILITY';
  externalEntityType: 'QUANTITY_AVAILABILITY';
  externalSessionId: string;
  /** Provider-reported remaining/capacity — advisory for the sellable calc. */
  remaining: number;
  capacity?: number;
}

export interface CancelSessionChange extends CanonicalChangeBase {
  kind: 'CANCEL_SESSION';
  externalEntityType: 'SESSION';
  externalSessionId: string;
  reason?: string;
}

export interface ProviderBookingStatusChange extends CanonicalChangeBase {
  kind: 'PROVIDER_BOOKING_STATUS';
  externalEntityType: 'BOOKING';
  externalBookingId: string;
  status: CanonicalBookingStatus;
}

export interface ProviderRefundStatusChange extends CanonicalChangeBase {
  kind: 'PROVIDER_REFUND_STATUS';
  externalEntityType: 'REFUND';
  externalBookingId: string;
  externalRefundId: string;
  status: CanonicalRefundStatus;
  amountMinor?: number;
  currency?: string;
}

export type CanonicalInventoryChange =
  | UpsertExperienceChange
  | UpsertVenueChange
  | UpsertScreenChange
  | UpsertSeatLayoutChange
  | UpsertSessionChange
  | UpdatePricingChange
  | UpdateSeatAvailabilityChange
  | UpdateQuantityAvailabilityChange
  | CancelSessionChange
  | ProviderBookingStatusChange
  | ProviderRefundStatusChange;

/** How a provider's inventory ownership is treated (ADR-040 §14). */
export type InventoryOwnershipMode = 'LOCAL_AUTHORITATIVE' | 'PROVIDER_AUTHORITATIVE' | 'ALLOCATED';
