import { useQuery } from '@tanstack/react-query';
import { getParsed } from '@/services/http';
import { eventDetailSchema } from './schema';

export const eventKeys = {
  all: ['event'] as const,
  detail: (slug: string) => [...eventKeys.all, slug] as const,
};

export function useEvent(slug: string) {
  return useQuery({
    queryKey: eventKeys.detail(slug),
    queryFn: () => getParsed(`/public/events/${encodeURIComponent(slug)}`, eventDetailSchema),
    enabled: Boolean(slug),
    // Short: `available` on each ticket type is inventory, and a stale count is how a
    // user picks four seats for a session that has one left.
    staleTime: 15_000,
  });
}
