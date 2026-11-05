'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { inCityScope, type CityPreference } from '@eticketsgo/web-kit';
import { api } from '@/lib/api';
import { getRecent, rememberRecentIds } from '@/lib/recent';
import { recentEventsQuery } from '@/lib/storefront-queries';
import { getSaved } from '@/lib/saved';

type LiveEvent = Awaited<ReturnType<typeof api.listEvents>>['data'][number];

/**
 * Events this browser remembers, re-asked of the catalogue rather than replayed from storage.
 *
 * ── WHY THIS IS ONE HOOK ───────────────────────────────────────────────────────────
 * "Recently viewed" existed twice — on the home page and on Explore — and each turned the
 * stored history into cards its own way. The home page was fixed to fetch live data; Explore
 * kept rendering the stored copies, so the owner opened Explore from the United States and
 * saw shows from 6 to 19 September (all over) in Hyderabad, Mumbai, Boise and Meridian, under
 * a header saying United States. Fixing one copy left the other, which is exactly what two
 * copies are for. Both pages now call this.
 *
 * ── WHY STORAGE IS TRUSTED FOR IDS ONLY ────────────────────────────────────────────
 * localStorage holds whole event objects, frozen on the day each was opened: title, price,
 * date. Nothing expires them. `/public/events?ids=` only returns events that are published
 * and still have a date to come, so anything finished, cancelled or withdrawn simply does not
 * come back, and what does is current. The ids are the one part that cannot go stale.
 *
 * Returned in the order the customer stored them, which the API has no reason to preserve.
 */
function useLiveEventsById(ids: string[]) {
  const query = useQuery({
    ...recentEventsQuery(ids),
    // With no ids there is nothing to ask for, and an empty `ids=` would come back as the
    // whole catalogue — a rail of strangers under "Recently viewed".
    enabled: ids.length > 0,
  });
  const events = useMemo(() => {
    const byId = new Map((query.data?.data ?? []).map((e) => [e.id, e]));
    return ids.map((id) => byId.get(id)).filter((e): e is LiveEvent => Boolean(e));
  }, [query.data, ids]);
  return { events, isLoading: query.isLoading && ids.length > 0 };
}

/**
 * What this customer recently looked at: current, still on sale, and inside the place they
 * are browsing — the same scope as every other list on the page.
 *
 * Scoped because the strip is an invitation to act, and an invitation to a show on another
 * continent is not one worth making; somebody who wants it back can search for its city.
 */
export function useRecentlyViewed(
  preference: CityPreference,
  /**
   * The ids the server read from the cookie mirror (`RECENT_COOKIE`), so the first render - on
   * the server and in the browser alike - already has the rail. Storage is still the truth: it
   * is read after mount and wins if the two disagree.
   */
  initialIds: readonly string[] = [],
) {
  const [ids, setIds] = useState<string[]>(() => [...initialIds]);
  // Read after mount: localStorage does not exist during the server render.
  useEffect(() => {
    const stored = getRecent()
      .map((e) => e.id)
      .slice(0, 12);
    if (stored.join(',') === initialIds.join(',')) return;
    setIds(stored);
    // A history from before the mirror existed, or one the cookie lost: put it back.
    rememberRecentIds(stored);
    // Only on mount: the ids the page started with are the ones to compare against.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const { events, isLoading } = useLiveEventsById(ids);
  const scoped = useMemo(
    () => events.filter((e) => inCityScope(e, preference)),
    [events, preference],
  );
  return { events: scoped, isLoading };
}

/**
 * The customer's saved events, current rather than as they were when the heart was pressed.
 *
 * NOT scoped by place: a saved event is a deliberate choice, and somebody who saved a show
 * in the city they are travelling to wants it there when they get home. What it does drop is
 * anything no longer on sale, and it says how many, so a list that got shorter is explained
 * rather than looking like it lost something.
 */
export function useSavedEvents() {
  // null until storage has been read, so the page never flashes "no saved events" first.
  const [ids, setIds] = useState<string[] | null>(null);
  // All of them (the store keeps at most 50): a bookmark past the twelfth is still a bookmark.
  useEffect(
    () =>
      setIds(
        getSaved()
          .map((e) => e.id)
          .slice(0, 50),
      ),
    [],
  );
  const { events, isLoading } = useLiveEventsById(ids ?? []);
  const ready = ids !== null && !isLoading;
  return { events, ready, noLongerOnSale: ready ? ids.length - events.length : 0 };
}
