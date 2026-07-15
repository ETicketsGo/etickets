import type { ResourceType, SharePermission } from '@eticketsgo/shared-types';

/**
 * The recipient-facing, permission-independent view of a shared resource. Generic
 * across resource types (tickets today; memberships / passes / vouchers next) so
 * the sharing UI and API never special-case a type. See ADR-032.
 */
export interface ShareView {
  resourceType: ResourceType;
  title: string;
  subtitle: string | null;
  status: string;
  reference: string | null;
  ticketType: string | null;
  attendeeName: string | null;
  seatLabel: string | null;
  venueName: string | null;
  screenName: string | null;
  cinemaName: string | null;
  startsAt: string | null;
  endsAt: string | null;
}

/**
 * A resource that can be shared. Ownership, capabilities and the display view are
 * expressed generically so `SharingService` operates on this interface, not on
 * `Ticket`. New wallet items implement this + register a resolver — no change to
 * the sharing engine (the CTO abstraction for Sprint 6).
 */
export interface ShareableResource {
  readonly resourceType: ResourceType;
  readonly id: string;
  readonly organizationId: string;
  /** The user who owns/controls the resource (may share it). */
  readonly ownerUserId: string | null;
  /** Live status (e.g. ticket status) used for policy + display. */
  readonly status: string;
  /** When the underlying experience ends (drives the `event_end` expiry preset). */
  readonly endsAt: Date | null;

  /** Whether a holder of this permission may be checked in at the gate. */
  canCheckIn(permission: SharePermission): boolean;
  /** Whether the live (scannable) QR should be exposed under this permission. */
  canShowLiveQr(permission: SharePermission): boolean;
  /** Whether ownership can be handed over under this permission. */
  canTransfer(permission: SharePermission): boolean;
  /** Whether the holder may download/export under this permission. */
  canDownload(permission: SharePermission): boolean;

  /** The scoped recipient view (never leaks owner-private data). */
  toShareView(): ShareView;
  /** A freshly-signed live QR token, or null when the resource has none. */
  liveQrToken(): string | null;
}
