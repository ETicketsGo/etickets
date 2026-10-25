import { normaliseSiteUrl } from './indexability.mjs';

/**
 * An address on this site that is safe to hand to someone else.
 *
 * ── WHY NOT `window.location` ─────────────────────────────────────────────────────
 * Every deployed storefront answers on two hosts: its own domain (qa.eticketsgo.com) and the
 * Railway one it is served from (customer-web-qa.up.railway.app). A link built from
 * `window.location` repeats whichever the visitor happened to arrive on, so anybody who opened
 * the site on the Railway host shared, copied and invited people to the Railway host - an
 * address that looks like somebody else's site, sent to a friend who is asked to trust it.
 *
 * `NEXT_PUBLIC_SITE_URL` is the site's address as configured for the environment; the same
 * value the page's canonical URL and sitemap use. The visitor's own origin is only the
 * fallback, for local development where nothing is configured - never a production default,
 * which would send a QA share to the live site.
 */
export function siteOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, '');
  if (configured) return configured;
  return typeof window === 'undefined' ? '' : window.location.origin;
}

/** `path` (with its leading slash, locale prefix already applied) on this site. */
export function siteUrl(path: string): string {
  return `${siteOrigin()}${path}`;
}

/** The page the visitor is on, on this site's own address. */
export function currentPageUrl(): string {
  if (typeof window === 'undefined') return '';
  return siteUrl(`${window.location.pathname}${window.location.search}`);
}

/**
 * The site's own address for metadata, the sitemap and robots.txt: the configured one, else
 * the production storefront (`https://www.eticketsgo.com`, never the bare apex, which only
 * forwards). Unlike `siteOrigin` it never reads the browser, so a server render and a client
 * render agree.
 *
 * The fallback is for URLs only. Whether a deployment may be INDEXED is decided by
 * `isIndexableDeployment` from the configured value, and an unset value is not production.
 */
export function canonicalSiteUrl(): string {
  return normaliseSiteUrl(process.env.NEXT_PUBLIC_SITE_URL);
}
