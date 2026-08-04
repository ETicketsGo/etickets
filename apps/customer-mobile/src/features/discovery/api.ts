import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { getParsed } from '@/services/http';
import {
  categoryCountSchema,
  discoverySchema,
  eventPageSchema,
  type CategoryCount,
} from './schema';
import { z } from 'zod';

/**
 * Query keys are centralised so an invalidation cannot miss a cache entry through a
 * typo'd key — `['events', filters]` and `['event', filters]` both compile.
 */
export const discoveryKeys = {
  all: ['discovery'] as const,
  home: () => [...discoveryKeys.all, 'home'] as const,
  categories: () => [...discoveryKeys.all, 'categories'] as const,
  search: (filters: EventFilters) => [...discoveryKeys.all, 'search', filters] as const,
};

export interface EventFilters {
  q?: string;
  city?: string;
  category?: string;
}

/** Home's composed sections: now showing, trending, this weekend, categories. */
export function useDiscovery() {
  return useQuery({
    queryKey: discoveryKeys.home(),
    queryFn: () => getParsed('/public/discovery', discoverySchema),
    // Discovery changes on the scale of hours, not seconds. A longer window means
    // returning to Home from an event does not re-fetch the whole shelf.
    staleTime: 5 * 60_000,
  });
}

export function useCategories() {
  return useQuery<CategoryCount[]>({
    queryKey: discoveryKeys.categories(),
    queryFn: () => getParsed('/public/categories', z.array(categoryCountSchema)),
    staleTime: 30 * 60_000,
  });
}

const PAGE_SIZE = 20;

/**
 * Paged event search. Infinite rather than paged because the list is a scroll: a user
 * reaching the bottom expects more results, not page-number controls.
 */
export function useEventSearch(filters: EventFilters, enabled = true) {
  return useInfiniteQuery({
    queryKey: discoveryKeys.search(filters),
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      getParsed('/public/events', eventPageSchema, {
        page: pageParam,
        pageSize: PAGE_SIZE,
        // Empty strings would be sent as `?q=` and are not the same as omitting the
        // filter — the API would search for the empty string.
        ...(filters.q ? { q: filters.q } : {}),
        ...(filters.city ? { city: filters.city } : {}),
        ...(filters.category ? { category: filters.category } : {}),
      }),
    getNextPageParam: (last) =>
      last.meta.page < last.meta.totalPages ? last.meta.page + 1 : undefined,
    enabled,
  });
}
