'use client';

import { useQueries } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { buyability, type Buyability } from '@/lib/home-feed';

/**
 * Whether each listed event can be bought now, for the cards that show a price.
 *
 * The listing payload has no availability or sales window, so a card that printed "From Rs 799"
 * from the listing alone did so over sold-out and closed shows too. The home page settled this
 * by reading each listed event's own page (`/public/events/:slug`, the same query and cache as
 * the event page) and showing a price only once that read proves something is on sale; this is
 * the same rule for the other lists, so a card says the same thing wherever it appears.
 *
 * Bounded by `max` (the first slugs, in page order) so a long page never fans out without
 * limit; an event past the bound shows its date and no price, never a guessed one.
 */
export function useBuyability(
  slugs: readonly string[],
  max = 36,
): Map<string, Buyability | undefined> {
  const checked = [...new Set(slugs)].slice(0, max);
  const details = useQueries({
    queries: checked.map((slug) => ({
      queryKey: ['event', slug],
      queryFn: () => api.getEvent(slug),
      staleTime: 60_000,
      retry: false,
    })),
  });
  return new Map<string, Buyability | undefined>(
    checked.map((slug, i) => {
      const q = details[i];
      // A listing whose page will not open (unpublished since) cannot be bought either.
      return [slug, q.data ? buyability(q.data) : q.isError ? 'CLOSED' : undefined];
    }),
  );
}
