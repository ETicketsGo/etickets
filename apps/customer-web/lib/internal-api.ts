import { isIP } from 'node:net';
import { headers } from 'next/headers';
import { setServerApiRoute, type ServerApiRoute } from '@eticketsgo/web-kit/server';

/**
 * How this server reads the API while rendering a page.
 *
 * ── THE FAILURE THIS CLOSES ────────────────────────────────────────────────────────
 * Page renders read the public catalogue through the PUBLIC API URL, so Railway's edge stamped
 * this server's address on every one. The API's rate limit counts per address: every visitor's
 * render shared one 120-a-minute budget (PROD load test, 2026-11-08: one call per page view, all
 * from Railway's egress). A busy minute would have throttled every visitor's render at once;
 * the page then falls back to the browser fetching, behind a skeleton.
 *
 * ── THE ROUTE NOW ──────────────────────────────────────────────────────────────────
 * With `INTERNAL_API_URL` (Railway's private address, e.g. http://api.railway.internal:8080/api)
 * and `INTERNAL_API_KEY` (a secret shared with the API, server-only, never NEXT_PUBLIC_), an
 * anonymous read goes over the private network carrying the key and the visitor's address as
 * THIS service's edge reported it (`x-real-ip`, set by Railway, not by the visitor). The API
 * then counts the read against that visitor (apps/api/src/common/client-ip.ts) - and only when
 * the request did not come through the public edge, so the headers are worthless from outside.
 *
 * Either variable missing (local development, an environment not set up yet): null, and every
 * read takes the public URL exactly as before.
 */
export function internalApiRoute(
  env: NodeJS.ProcessEnv,
  visitorIp: string | null | undefined,
): ServerApiRoute {
  const base = (env.INTERNAL_API_URL ?? '').trim().replace(/\/+$/, '');
  const key = (env.INTERNAL_API_KEY ?? '').trim();
  if (!/^https?:\/\/[^\s]+$/.test(base) || key.length < 32) return null;
  const headerSet: Record<string, string> = { 'x-etg-internal-key': key };
  const ip = (visitorIp ?? '').trim();
  if (ip && !ip.includes(',') && isIP(ip)) headerSet['x-etg-client-ip'] = ip;
  return { base, headers: headerSet };
}

let registered = false;

/** Points the kit's server-side reads at the private route. Idempotent. */
export function registerInternalApiRoute(): void {
  if (registered) return;
  registered = true;
  setServerApiRoute(async () => {
    let visitor: string | null = null;
    try {
      visitor = (await headers()).get('x-real-ip');
    } catch {
      // Outside a request (build time, a static page): no visitor to name.
    }
    return internalApiRoute(process.env, visitor);
  });
}
