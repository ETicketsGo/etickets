import { cookies } from 'next/headers';
import { QueryClient, dehydrate, type DehydratedState } from '@tanstack/react-query';
import { registerInternalApiRoute } from '@/lib/internal-api';

// Server-side reads go over the private network and spend their visitor's rate-limit budget.
registerInternalApiRoute();

/** See `prefetchPublic`: set to `off`, the browser fetches every read itself. */
export const PREFETCH_OFF_COOKIE = 'etg_prefetch';

/**
 * Fetches a page's above-the-fold reads on the server, for the browser to start from.
 *
 * ── WHAT THIS IS FOR ───────────────────────────────────────────────────────────────
 * The storefront's pages are client components that read the API through React Query. Rendered
 * on the server with an empty cache, they drew skeletons; the browser then fetched, and the page
 * filled in and pushed itself around - and the footer, briefly in the middle of the screen,
 * made it look like a different page had loaded first. With these answers in the cache, the
 * server's HTML is the finished page and the browser hydrates it without asking again
 * (the same keys, from `lib/storefront-queries.ts`).
 *
 * ── A BUDGET, NOT A PROMISE ────────────────────────────────────────────────────────
 * The page waits at most `budgetMs` for the API. Anything not back by then (or failed) is
 * simply left out and the browser fetches it as before, behind the page's own skeleton. A slow
 * API costs a skeleton, never a slow or broken page. No retries on the server.
 *
 * The browser does no extra work: these are the requests it would have made itself, made once
 * from the server instead.
 */
export async function prefetchPublic(
  load: (client: QueryClient) => Promise<unknown>,
  budgetMs = 2500,
): Promise<DehydratedState> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 15_000 } },
  });
  /*
    `etg_prefetch=off` hands every read back to the browser, exactly as before this existed.

    For the end-to-end journeys that stand in for the API inside the browser (a show that cannot
    be sold, a seat map with a given shape, a catalogue of five cities): the server cannot see
    those stand-ins, so they ask it not to answer first. It only ever makes a page do more work
    in the visitor's own browser; it unlocks nothing.
  */
  if ((await cookies()).get(PREFETCH_OFF_COOKIE)?.value === 'off') return dehydrate(client);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    load(client).catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, budgetMs);
    }),
  ]);
  clearTimeout(timer);
  // Only answers that arrived: a pending or failed query is the browser's to fetch.
  return dehydrate(client, {
    shouldDehydrateQuery: (query) => query.state.status === 'success',
  });
}
