/**
 * A server-side read of the public catalogue, with the three answers kept apart.
 *
 * `not-found` is the API saying, definitely, that the thing does not exist or is not
 * published (HTTP 404) - the page can then answer 404 too. `error` is everything else: the
 * API down, a timeout, a 500. Those must never turn into a 404, or one bad minute at the API
 * would tell search engines that every event had been deleted.
 */
export type PublicResult<T> =
  { kind: 'ok'; data: T } | { kind: 'not-found' } | { kind: 'error'; status?: number };

export async function loadPublic<T>(
  url: string,
  fetcher: typeof fetch = fetch,
  revalidate = 3600,
): Promise<PublicResult<T>> {
  try {
    const res = await fetcher(url, { next: { revalidate } } as RequestInit);
    if (res.status === 404) return { kind: 'not-found' };
    if (!res.ok) return { kind: 'error', status: res.status };
    return { kind: 'ok', data: (await res.json()) as T };
  } catch {
    return { kind: 'error' };
  }
}
