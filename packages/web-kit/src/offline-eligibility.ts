// Offline eligibility (ADR-034). Pure, framework-free policy deciding which
// already-issued assets may be cached for offline display. Generic so future
// wallet items (Membership, Parking, Coupon, SeasonPass) implement their own
// rules. Offline is a resilience feature, NOT an authorization bypass: the gate
// still validates signature, nonce, status, session and ownership at check-in.

import type { WalletTicket } from './api';

/** Sync/connectivity state surfaced to the user (never silently "synced"). */
export type OfflineSyncState =
  | 'CURRENT' // online, cache fresh
  | 'SYNCING' // fetching now
  | 'STALE' // offline (or fetch failed) but a cached copy is shown
  | 'OFFLINE' // offline and nothing cached
  | 'PARTIAL' // some items synced, some failed
  | 'FAILED' // sync failed and no cache
  | 'REQUIRES_SIGN_IN'; // no session

/**
 * Ticket statuses eligible for offline caching. CHECKED_IN is kept for historical
 * display only (the pass has already been used). Everything else — pending,
 * cancelled, refunded, void, expired, declined, revoked — is never cached.
 */
export const OFFLINE_ELIGIBLE_TICKET_STATUSES = ['ACTIVE', 'CHECKED_IN'] as const;

/** Generic asset shape the eligibility policy reasons about. */
export interface OfflineEligibilityInput {
  /** Last-known lifecycle status (ticket status / asset status). */
  status: string;
  /** Whether the viewer owns the underlying booking/asset. */
  ownedByViewer?: boolean;
  /** Whether the asset is currently assigned to the viewer. */
  assignedToViewer?: boolean;
  /** Assignment lifecycle, when applicable. */
  assignmentStatus?: string;
  /** Whether a display QR/access representation exists to show offline. */
  hasQr: boolean;
}

/**
 * Generic offline-eligibility decision. An asset may be cached only if it is
 * issued, in an eligible status, held by the viewer, and has something to show.
 */
export function isOfflineEligible(input: OfflineEligibilityInput): boolean {
  if (!input.hasQr) return false;
  if (!(OFFLINE_ELIGIBLE_TICKET_STATUSES as readonly string[]).includes(input.status)) {
    return false;
  }
  // Must be held by the viewer: assigned to them, or owned-and-not-given-away.
  const heldByViewer =
    input.assignedToViewer === true ||
    (input.ownedByViewer === true && input.assignmentStatus !== 'ACCEPTED');
  // When ownership context is unknown (older payloads), fall back to true — the
  // wallet API only returns the user's own tickets, so it's safe.
  const contextKnown = input.ownedByViewer !== undefined || input.assignedToViewer !== undefined;
  return contextKnown ? heldByViewer : true;
}

/** Whether a wallet ticket may be cached offline. */
export function isTicketOfflineEligible(t: WalletTicket): boolean {
  return isOfflineEligible({
    status: t.status,
    ownedByViewer: t.ownedByViewer,
    assignedToViewer: t.assignedToViewer,
    assignmentStatus: t.assignmentStatus,
    hasQr: !!t.qrDataUrl,
  });
}

/** Filters a wallet response down to the tickets that may be stored offline. */
export function offlineEligibleTickets(tickets: WalletTicket[]): WalletTicket[] {
  return tickets.filter(isTicketOfflineEligible);
}
