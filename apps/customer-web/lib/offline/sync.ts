// Offline sync engine (ADR-034). Network-first with an IndexedDB fallback. On a
// successful fetch it persists the offline-eligible slice (server wins → the cache
// is replaced, purging transferred/refunded/nonce-rotated items). Offline, it
// hydrates the last cached copy. No polling loop — sync is event-driven (login,
// foreground, reconnect, before Event Day Mode) via React Query's refetch hooks.

import type { WalletTicket } from '@eticketsgo/web-kit';
import { api } from '@/lib/api';
import { currentUserId } from './identity';
import { loadWallet, saveWallet } from './wallet-store';

/** The wallet query's value: tickets are uniform (WalletTicket[]) across the app. */
export async function fetchWalletWithOffline(): Promise<WalletTicket[]> {
  const userId = currentUserId();
  try {
    const tickets = await api.wallet();
    if (userId) await saveWallet(userId, tickets);
    return tickets;
  } catch (err) {
    const record = userId ? await loadWallet(userId) : null;
    if (record) return record.items;
    throw err;
  }
}

/**
 * A single ticket, offline-aware (v1.4 WS8): network-first, falling back to the
 * cached wallet copy in IndexedDB so an installed/offline device can still show the
 * pass + its QR. Reuses the same user-scoped store as the wallet list.
 */
export async function fetchTicketWithOffline(ticketId: string): Promise<WalletTicket> {
  const userId = currentUserId();
  try {
    return await api.getTicket(ticketId);
  } catch (err) {
    const record = userId ? await loadWallet(userId) : null;
    const found = record?.items.find((t) => t.id === ticketId);
    if (found) return found;
    throw err;
  }
}

/** Reads the last successful sync time for the current user (for "Updated …"). */
export async function lastSyncedAt(): Promise<number | null> {
  const userId = currentUserId();
  if (!userId) return null;
  const record = await loadWallet(userId);
  return record?.syncedAt ?? null;
}

// `deriveSyncState` now lives in @eticketsgo/web-kit alongside the connectivity model, so the wallet
// label is derived from real API-origin reachability (not just the sometimes-stale navigator.onLine).
export { deriveSyncState } from '@eticketsgo/web-kit';
