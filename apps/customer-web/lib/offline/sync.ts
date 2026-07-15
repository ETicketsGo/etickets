// Offline sync engine (ADR-034). Network-first with an IndexedDB fallback. On a
// successful fetch it persists the offline-eligible slice (server wins → the cache
// is replaced, purging transferred/refunded/nonce-rotated items). Offline, it
// hydrates the last cached copy. No polling loop — sync is event-driven (login,
// foreground, reconnect, before Event Day Mode) via React Query's refetch hooks.

import type { OfflineSyncState, WalletTicket } from '@eticketsgo/web-kit';
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

/** Reads the last successful sync time for the current user (for "Updated …"). */
export async function lastSyncedAt(): Promise<number | null> {
  const userId = currentUserId();
  if (!userId) return null;
  const record = await loadWallet(userId);
  return record?.syncedAt ?? null;
}

/** Derives the user-facing sync state (never silently "synced"). */
export function deriveSyncState(opts: {
  hasToken: boolean;
  online: boolean;
  isFetching: boolean;
  hasData: boolean;
  isError: boolean;
}): OfflineSyncState {
  if (!opts.hasToken) return 'REQUIRES_SIGN_IN';
  if (opts.isFetching) return 'SYNCING';
  if (opts.online) return opts.hasData ? 'CURRENT' : opts.isError ? 'FAILED' : 'SYNCING';
  // Offline:
  if (opts.hasData) return 'STALE';
  return 'OFFLINE';
}
