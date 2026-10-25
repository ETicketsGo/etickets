/**
 * Whether search engines may index this deployment, decided from CONFIGURATION.
 *
 * -- WHY A PLAIN .mjs FILE ------------------------------------------------------------
 * `next.config.mjs` needs this rule for its `headers()` (the `X-Robots-Tag` on every
 * response, static files included), and `next.config.mjs` cannot import TypeScript. The
 * TypeScript side (`lib/seo.ts`, the middleware, `robots.ts`, `sitemap.ts`) imports this same
 * file, so there is exactly one rule and the config and the pages cannot disagree.
 *
 * -- THE RULE ---------------------------------------------------------------------------
 * Production is the deployment whose configured site URL (`NEXT_PUBLIC_SITE_URL`) has the
 * host `www.eticketsgo.com` AND whose `NEXT_PUBLIC_APP_ENV` is unset or PRODUCTION (QA and
 * UAT set their own name, which is the same signal as the "Test environment" notice).
 * Everything else - QA, UAT, a local build with nothing configured, a typo - is NOT
 * production and is not indexable. Fail closed: a test copy of the shop in Google is worse
 * than a missing page, and production is pinned by a unit test so it cannot quietly flip.
 *
 * Both values are build arguments (see the Dockerfile), so the answer is fixed per build.
 */

/** The one host that may be indexed. */
export const CANONICAL_HOST = 'www.eticketsgo.com';

/** The site's address when nothing is configured. Used for URLs, never for the index decision. */
export const DEFAULT_SITE_URL = 'https://www.eticketsgo.com';

/** The header value for a deployment that must stay out of every index. */
export const NOINDEX_ALL = 'noindex, nofollow';

/** The header value for a production page reached on a host that is not the canonical one. */
export const NOINDEX_ALIAS = 'noindex';

/**
 * The configured site URL without a trailing slash, or the default when nothing is set.
 * @param {string | undefined | null} raw
 * @returns {string}
 */
export function normaliseSiteUrl(raw) {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '');
  return trimmed || DEFAULT_SITE_URL;
}

/**
 * @param {string | undefined | null} raw
 * @returns {string | null} the lower-case host of a URL, or null when it is not a URL.
 */
function hostOf(raw) {
  try {
    return new URL(String(raw ?? '').trim()).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * @param {{ siteUrl?: string | null, appEnv?: string | null }} config
 * @returns {boolean} true only for the production storefront.
 */
export function isIndexableDeployment(config) {
  const env = (config.appEnv ?? '').trim().toUpperCase();
  if (env !== '' && env !== 'PRODUCTION') return false;
  return hostOf(config.siteUrl) === CANONICAL_HOST;
}

/**
 * Hosts that a crawler cannot reach, or that say the proxy did not pass the public host on.
 * For these we do not know which public name was used, so we add nothing rather than risk
 * marking the real site noindex.
 * @param {string} host lower-case, port removed
 */
function isPrivateHost(host) {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
    host.startsWith('[') ||
    !host.includes('.')
  );
}

/**
 * The `X-Robots-Tag` a response needs, or null for none.
 *
 * - Not production: `noindex, nofollow` on everything.
 * - Production, on the canonical host: nothing (indexable).
 * - Production, on another public host (the generated `*.up.railway.app` name, the bare
 *   apex if it ever serves pages instead of redirecting): `noindex`, so the duplicate never
 *   competes with www. Links are still followed.
 *
 * @param {{ indexable: boolean, host?: string | null }} input
 * @returns {string | null}
 */
export function robotsTagFor(input) {
  if (!input.indexable) return NOINDEX_ALL;
  const host = (input.host ?? '').split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
  if (!host || isPrivateHost(host)) return null;
  return host === CANONICAL_HOST ? null : NOINDEX_ALIAS;
}
