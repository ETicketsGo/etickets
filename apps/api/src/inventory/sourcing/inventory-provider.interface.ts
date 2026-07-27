import type { Prisma } from '@prisma/client';
import type { ExperienceType } from '@eticketsgo/shared-types';

/**
 * Provider-agnostic inventory SOURCING abstraction (ADR-037).
 *
 * This is orthogonal to {@link InventoryStrategy} (ADR-010): a *strategy* decides
 * HOW units are counted/held for an experience type (seat-based vs general
 * admission); a *provider* decides WHERE the stock lives and who is authoritative —
 * our own DB (Direct / Manual) or a future external theatre / aggregator API.
 *
 * The booking engine, resolver and failover logic depend only on this interface, so
 * new inventory sources plug in via DI without any business logic changing, and a
 * user can never tell which source served their booking.
 */

/** Where an inventory item's stock and truth ultimately live. */
export type InventoryAuthority = 'LOCAL' | 'REMOTE';

/** How a provider was integrated — surfaced for ops/analytics, NEVER to end users. */
export type InventorySourceKind = 'DIRECT' | 'MANUAL' | 'AGGREGATOR';

export interface InventoryProviderCapabilities {
  /** Serves catalogue search itself (vs. search served by the discovery domain). */
  readonly search: boolean;
  /** Truth lives remotely and must be reconciled via sync()/webhooks. */
  readonly authority: InventoryAuthority;
  /**
   * May the resolver fail a request over to another provider for the same item?
   * Authoritative LOCAL stock is single-sourced, so it is never failed over; a
   * REMOTE mirror may be, when business rules allow (see InventoryResolver).
   */
  readonly failover: boolean;
}

/** One inventory demand line — N units of a ticket type, optional specific seats. */
export interface InventoryLineRequest {
  ticketTypeId: string;
  quantity: number;
  seatIds?: string[];
}

export interface SearchQuery {
  experienceType?: ExperienceType;
  text?: string;
  city?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

export interface SearchResultItem {
  /** Provider-scoped external id; opaque to callers. */
  externalId: string;
  experienceType: ExperienceType;
  title: string;
  startsAt?: Date;
  venueName?: string;
}

export interface AvailabilityQuery {
  experienceType: ExperienceType;
  eventSessionId: string;
  ticketTypeIds: string[];
  /** Read client (tx or root). LOCAL providers use it; REMOTE providers ignore it. */
  client?: Prisma.TransactionClient;
}

export interface AvailabilitySnapshot {
  /** Available units per ticket type id (absent/0 ⇒ sold out). */
  unitsByTicketType: Record<string, number>;
  /** When this snapshot was produced (REMOTE snapshots may be eventually consistent). */
  asOf: Date;
  /** REMOTE snapshots may lag; LOCAL is always authoritative. */
  authority: InventoryAuthority;
}

/**
 * Shared context for a booking-scoped write (lock/confirm/cancel). An optional
 * caller-owned Prisma transaction lets LOCAL providers compose atomically with the
 * surrounding booking writes (preserving the existing single-transaction oversell
 * guarantee); REMOTE providers ignore `tx` and round-trip to the vendor.
 */
export interface InventoryWriteContext {
  experienceType: ExperienceType;
  eventSessionId: string;
  bookingId: string;
  lines: InventoryLineRequest[];
  tx?: Prisma.TransactionClient;
}

export interface LockRequest extends InventoryWriteContext {
  /** When the hold must auto-expire if payment doesn't complete. */
  holdExpiresAt: Date;
}

export interface LockResult {
  /** Provider-scoped hold handle (LOCAL: the bookingId; REMOTE: vendor lock id). */
  lockRef: string;
  expiresAt: Date;
  authority: InventoryAuthority;
}

export interface ConfirmResult {
  /** External confirmation reference (LOCAL: bookingId; REMOTE: vendor booking id). */
  confirmationRef: string;
  /** Tickets to issue (one per unit/seat) — issuance itself stays in the booking domain. */
  tickets: Array<{ ticketTypeId: string; seatId?: string; seatLabel?: string }>;
}

export interface RefundInventoryRequest {
  experienceType: ExperienceType;
  eventSessionId: string;
  bookingId: string;
  tickets: Array<{ ticketTypeId: string; seatId?: string | null }>;
  tx?: Prisma.TransactionClient;
}

export interface SyncRequest {
  /** Optional narrow scope; omit for a full provider sync. */
  eventSessionId?: string;
  reason?: 'WEBHOOK' | 'SCHEDULED' | 'MANUAL';
}

export interface SyncResult {
  itemsReconciled: number;
  authority: InventoryAuthority;
}

export interface ProviderHealth {
  healthy: boolean;
  /** Short machine reason when unhealthy (never secrets/PII). */
  reason?: string;
  checkedAt: Date;
}

/**
 * The provider-agnostic inventory sourcing contract (ADR-037). Every source
 * implements all eight operations (a uniform surface). Where a source genuinely
 * cannot serve an operation it throws a clear AppException — it NEVER fabricates a
 * result (a placeholder aggregator throws until it is really integrated).
 */
export interface InventoryProvider {
  readonly name: string;
  readonly sourceKind: InventorySourceKind;
  readonly capabilities: InventoryProviderCapabilities;

  search(query: SearchQuery): Promise<SearchResultItem[]>;
  availability(query: AvailabilityQuery): Promise<AvailabilitySnapshot>;
  lockInventory(req: LockRequest): Promise<LockResult>;
  confirmBooking(ctx: InventoryWriteContext): Promise<ConfirmResult>;
  cancelBooking(ctx: InventoryWriteContext): Promise<void>;
  refund(req: RefundInventoryRequest): Promise<void>;
  sync(req: SyncRequest): Promise<SyncResult>;
  health(): Promise<ProviderHealth>;
}

/** DI token for the registry-backed resolver (parity with PAYMENT_PROVIDER). */
export const INVENTORY_PROVIDER = Symbol('INVENTORY_PROVIDER');
