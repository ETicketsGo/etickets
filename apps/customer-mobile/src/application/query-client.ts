import { QueryClient } from '@tanstack/react-query';

/**
 * A single QueryClient with mobile-appropriate defaults: retry transient errors,
 * keep data fresh for a short window, and refetch on reconnect (handled with
 * NetInfo in the online provider).
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
    },
    mutations: { retry: 0 },
  },
});
