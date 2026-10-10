'use client';

import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Cinema, type ShowRow } from '@eticketsgo/web-kit';
import { eventSaleStates } from '../../lib/sale-state';
import { isUpcoming, type MaybeSale } from './cinema-model';

/** The organization's cinemas, with lookups for each one's zone and state. */
export function useCinemas(organizationId: string) {
  const q = useQuery({
    queryKey: ['cinemas', organizationId],
    queryFn: () => api.cinemas.list(organizationId),
  });
  const byId = useMemo(() => new Map((q.data ?? []).map((c) => [c.id, c])), [q.data]);
  /*
    The cinema's zone is authoritative for every time on these pages. Undefined until the
    cinema list has loaded - a caller formats with the reader's zone only in that moment.
  */
  const zoneOf = useCallback(
    (cinemaId: string | null | undefined) => (cinemaId ? byId.get(cinemaId)?.timezone : undefined),
    [byId],
  );
  return { ...q, byId, zoneOf };
}

/** The state a cinema is in, for the regulatory sale reasons ("Telangana"). */
export const regionOf = (c: Cinema | undefined): string | null =>
  c?.region ?? c?.venue?.region ?? null;

/**
 * The server's unified sale state of every cinema listing (one event per film per venue) these
 * upcoming shows belong to - the same answer the Overview and the event pages read.
 *
 * One request per 50 listings; a library is tens of films at a handful of cinemas. `listing`
 * answers `undefined` while loading and `null` when the answer could not be read (an operator
 * without access - owners and managers only - or an older API), which the pages render as
 * "not confirmed", never as "Selling".
 */
export function useListingSales(organizationId: string, rows: ShowRow[], now: Date) {
  const ids = useMemo(
    () =>
      [
        ...new Set(
          rows.filter((s) => isUpcoming(s, now) && s.eventId).map((s) => s.eventId as string),
        ),
      ].sort(),
    [rows, now],
  );
  const q = useQuery({
    queryKey: ['organizer-event-sale-states', organizationId, ids.join(',')],
    queryFn: () => eventSaleStates(organizationId, ids),
    enabled: ids.length > 0,
    staleTime: 60_000,
    retry: false,
  });
  const byId = useMemo(() => new Map((q.data ?? []).map((e) => [e.eventId, e])), [q.data]);
  const listing = useCallback(
    (eventId: string): MaybeSale =>
      q.isError ? null : q.data ? (byId.get(eventId) ?? null) : undefined,
    [q.isError, q.data, byId],
  );
  return { listing, loading: q.isLoading };
}
