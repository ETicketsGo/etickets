import { useEffect, useState } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { useOnline } from '@/hooks/use-online';
import {
  readTickets,
  saveTickets,
  type CacheReadResult,
  type CachedTicket,
} from '@/services/ticket-cache';
import { useTickets } from './api';

export interface OfflineTicketsResult {
  tickets: CachedTicket[];
  /** True when what is on screen came from disk rather than from the API just now. */
  fromCache: boolean;
  /** Epoch ms of the last successful authenticated fetch, when known. */
  syncedAt: number | null;
  /** Cache is older than the freshness window — show it, but say so more loudly. */
  stale: boolean;
  /** Saved data could not be read. Distinct from "no tickets". */
  corrupt: boolean;
  loading: boolean;
  /** Network failed AND there was nothing usable on disk. */
  unavailable: boolean;
  refetch: () => void;
}

/**
 * Tickets, with the cache as a first-class source rather than an afterthought.
 *
 * The network result always wins when it arrives — the cache is only ever consulted
 * while the request is in flight or after it has failed. That ordering matters: a
 * cancelled ticket must not keep showing as valid because a stale copy is on disk.
 *
 * Writing back happens only on a successful AUTHENTICATED fetch, so a signed-out or
 * failed request can never overwrite a good wallet with nothing.
 */
export function useOfflineTickets(): OfflineTicketsResult {
  const { user, isAuthenticated } = useAuth();
  const online = useOnline();
  const query = useTickets();
  const userId = user?.id ?? '';

  /**
   * The loaded cache is stored WITH the user it belongs to, and a mismatch is resolved
   * during render rather than by clearing it in an effect.
   *
   * That is not a style preference. Clearing on user change means there is a render
   * between "user switched" and "effect ran" in which the previous account's tickets
   * are still in state — a one-frame cross-account leak on exactly the screen where it
   * matters most. Comparing the stored id makes the stale entry unreadable immediately.
   */
  const [loaded, setLoaded] = useState<{ userId: string; result: CacheReadResult } | null>(null);
  const cache = loaded && loaded.userId === userId ? loaded.result : null;

  // Read from disk as soon as we know who the user is, so an offline cold start has
  // something to show without waiting for a request to time out.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void readTickets(userId).then((result) => {
      if (!cancelled) setLoaded({ userId, result });
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // Persist every successful authenticated fetch.
  useEffect(() => {
    if (!isAuthenticated || !userId || !query.isSuccess || !query.data) return;
    let cancelled = false;
    void saveTickets(userId, query.data)
      .then(() => readTickets(userId))
      .then((result) => {
        if (!cancelled) setLoaded({ userId, result });
      });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, userId, query.isSuccess, query.data]);

  const live = query.isSuccess && query.data ? query.data : null;

  if (live) {
    return {
      // The live payload includes qrToken; the screens only ever read qrDataUrl, and
      // the cached shape omits it. Narrowing here keeps both paths on one type so a
      // component cannot accidentally depend on the credential being present.
      tickets: live.map(({ qrToken: _qrToken, ...rest }) => rest),
      fromCache: false,
      syncedAt: cache?.status === 'ok' || cache?.status === 'stale' ? cache.syncedAt : null,
      stale: false,
      corrupt: false,
      loading: false,
      unavailable: false,
      refetch: () => void query.refetch(),
    };
  }

  const cached =
    cache?.status === 'ok' || cache?.status === 'stale'
      ? { tickets: cache.tickets, syncedAt: cache.syncedAt, stale: cache.status === 'stale' }
      : null;

  // Still waiting on the network and nothing on disk yet.
  const loading = query.isPending && !cached && loaded === null;

  return {
    tickets: cached?.tickets ?? [],
    fromCache: Boolean(cached),
    syncedAt: cached?.syncedAt ?? null,
    stale: cached?.stale ?? false,
    corrupt: cache?.status === 'corrupt',
    loading,
    // Only "unavailable" once the request has actually failed and the cache is no help.
    // While merely offline with a good cache, the screen is perfectly usable.
    unavailable: query.isError && !cached && !online,
    refetch: () => void query.refetch(),
  };
}
