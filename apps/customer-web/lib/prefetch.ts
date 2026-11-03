import { QueryClient, dehydrate, type DehydratedState } from '@tanstack/react-query';

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
