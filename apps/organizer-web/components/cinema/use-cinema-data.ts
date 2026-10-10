'use client';

import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Cinema, type ShowRow } from '@eticketsgo/web-kit';
import { eventSaleStates, sessionSaleStates } from '../../lib/sale-state';
import { isUpcoming, showSaleVerdict, type MaybeSale, type SaleVerdict } from './cinema-model';

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

/**
 * The server's unified sale state for each of these shows, as a verdict in words - the same
 * answer the Overview, the event pages and checkout read. One request per 50 shows.
 *
 * `undefined` while loading ("Checking sale status"), `null` when it could not be read - an
 * operator without access, or an older API ("Sale status unavailable"). Never a guess.
 */
export function useShowVerdicts(
  organizationId: string,
  rows: ShowRow[],
  zoneOf: (cinemaId: string | null | undefined) => string | undefined,
) {
  const ids = useMemo(() => [...new Set(rows.map((s) => s.sessionId))].sort(), [rows]);
  /*
    The key carries what each row says about itself, not only its id. A show paused, reopened,
    cancelled or moved comes back from its own list with a new status or window, and its sale
    state has to be asked again: keyed on ids alone, a paused show kept saying "Selling" for
    as long as the cached answer lived.
  */
  const facts = useMemo(
    () =>
      [...rows]
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
        .map(
          (s) =>
            `${s.sessionId}:${s.status}:${s.startsAt}:${s.salesStartAt ?? ''}:${s.salesEndAt ?? ''}`,
        )
        .join(','),
    [rows],
  );
  const q = useQuery({
    queryKey: ['organizer-sale-eligibility', organizationId, facts],
    queryFn: () => sessionSaleStates(organizationId, ids),
    enabled: ids.length > 0,
    staleTime: 30_000,
    retry: false,
  });
  const bySession = useMemo(() => new Map((q.data ?? []).map((a) => [a.sessionId, a])), [q.data]);
  return useCallback(
    (s: ShowRow): SaleVerdict =>
      showSaleVerdict({
        show: s,
        timeZone: zoneOf(s.cinemaId),
        sale: q.isError ? null : q.data ? (bySession.get(s.sessionId) ?? null) : undefined,
      }),
    [q.isError, q.data, bySession, zoneOf],
  );
}
