'use client';

import { useCallback, useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { api, type Cinema } from '@eticketsgo/web-kit';
import { cinemaSaleState, type CinemaSaleState } from './cinema-model';

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
 * Whether checkout would sell at each of these cinemas, from the server.
 *
 * One readiness report per cinema that actually has upcoming shows - its SALES section runs
 * `saleEligibility` over every upcoming show there (#280). An operator without access to the
 * report (the server allows owners and managers) gets UNKNOWN, which the pages render as "not
 * confirmed", never as "Selling".
 */
export function useCinemaSales(cinemaIds: string[], byId: Map<string, Cinema>) {
  const ids = useMemo(() => [...new Set(cinemaIds)].sort(), [cinemaIds]);
  const { reports, loading } = useQueries({
    queries: ids.map((id) => ({
      queryKey: ['cinema', id, 'pilot-readiness'],
      queryFn: () => api.cinemas.pilotReadiness(id),
      staleTime: 60_000,
      retry: false,
    })),
    combine: (results) => ({
      reports: results.map((r) => r.data),
      loading: results.some((r) => r.isLoading),
    }),
  });
  const states = useMemo(() => {
    const m = new Map<string, CinemaSaleState>();
    ids.forEach((id, i) => {
      const report = reports[i];
      m.set(id, report ? cinemaSaleState(report, regionOf(byId.get(id))) : { kind: 'UNKNOWN' });
    });
    return m;
  }, [ids, byId, reports]);
  const stateOf = useCallback(
    (id: string | null | undefined): CinemaSaleState =>
      (id ? states.get(id) : undefined) ?? { kind: 'UNKNOWN' },
    [states],
  );
  return { stateOf, loading };
}
