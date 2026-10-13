'use client';

import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';
import { placeGroupRequests } from '@eticketsgo/web-kit';
import { api, type PublicEventCard } from '@/lib/api';

/**
 * The events UNDER the selected place: the rest of its country, then each other country.
 *
 * One small request per group (see `placeGroupRequests` for why not one big read). The page's
 * own search (category, dates, text) is merged in, so "comedy" under Mumbai also shows comedy
 * elsewhere rather than everything. Events in `skip` (already on the page above) are not
 * repeated, and an empty group is dropped rather than drawn as a heading over nothing.
 *
 * Each item keeps its own venue city, currency and venue time zone: nothing is converted here.
 */
export function usePlaceGroups(
  place: { city?: string | null; country?: string | null },
  {
    filters = {},
    perGroup = 8,
    skip,
    enabled = true,
  }: {
    filters?: Record<string, string | undefined>;
    perGroup?: number;
    skip?: ReadonlySet<string>;
    enabled?: boolean;
  } = {},
) {
  const requests = useMemo(
    () => placeGroupRequests(place),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [place.city, place.country],
  );
  const results = useQueries({
    queries: requests.map((r) => ({
      queryKey: ['events', 'place-group', r.kind, r.params, filters, perGroup],
      queryFn: () => api.listEvents({ ...filters, ...r.params, pageSize: String(perGroup) }),
      enabled,
      staleTime: 30_000,
    })),
  });

  // A fixed-size dependency: the number of groups changes with the place, which a spread of
  // the results would turn into a hook-dependency array that changes length between renders.
  const version = results.map((q) => q.dataUpdatedAt).join(',');
  return useMemo(() => {
    let sameCountry: PublicEventCard[] = [];
    const elsewhere: { code: string; name: string; items: PublicEventCard[] }[] = [];
    requests.forEach((r, i) => {
      const items = (results[i]?.data?.data ?? []).filter((e) => !skip?.has(e.id));
      if (items.length === 0) return;
      if (r.kind === 'sameCountry') sameCountry = items;
      else elsewhere.push({ code: r.code, name: r.name, items });
    });
    return { sameCountry, elsewhere };
    // `results` is a new array every render; `version` says when its contents changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requests, skip, version]);
}
