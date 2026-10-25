import type { MetadataRoute } from 'next';
import { LOCALES, DEFAULT_LOCALE } from '@eticketsgo/i18n';

/**
 * Paths that are somebody's own account, purchase or link. The pages also say noindex; this
 * keeps well-behaved crawlers from spending their visit on them. Each is listed with every
 * locale prefix, because `/fr-CA/account` is the same private page as `/account`.
 */
export const PRIVATE_PATHS = [
  '/account',
  '/booking',
  '/checkout',
  '/shows',
  '/login',
  '/register',
  '/invite',
  '/reset-password',
  '/forgot-password',
  '/share',
] as const;

export function disallowedPaths(): string[] {
  const prefixes = LOCALES.filter((l) => l !== DEFAULT_LOCALE).map((l) => `/${l}`);
  return [
    ...PRIVATE_PATHS,
    ...prefixes.flatMap((p) => PRIVATE_PATHS.map((path) => `${p}${path}`)),
    // This app's own route handlers.
    '/api/',
  ];
}

/**
 * robots.txt for this build.
 *
 * Production: everything public may be crawled - by search engines and by AI search
 * crawlers alike (GPTBot, OAI-SearchBot, PerplexityBot, ClaudeBot all fall under `*`) - and
 * the sitemap is advertised. Anything else (QA, UAT, an unconfigured build): `Disallow: /`
 * for everyone and no sitemap, so a test copy of the shop is never crawled.
 *
 * No `Host:` line: it was a Yandex-only extension that Google ignores, and the canonical
 * host is already said by every page's canonical link.
 */
export function buildRobots(input: { indexable: boolean; siteUrl: string }): MetadataRoute.Robots {
  if (!input.indexable) {
    return { rules: { userAgent: '*', disallow: '/' } };
  }
  return {
    rules: { userAgent: '*', allow: '/', disallow: disallowedPaths() },
    sitemap: `${input.siteUrl}/sitemap.xml`,
  };
}
