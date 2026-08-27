import type { MetadataRoute } from 'next';
import { DEFAULT_LOCALE, LOCALES } from '@eticketsgo/i18n';
import { POSTS } from '@/lib/blog';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://eticketsgo.com';

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const routes = [
    '',
    '/features',
    '/pricing',
    '/solutions',
    '/organizers',
    '/customers',
    '/about',
    '/contact',
    '/faq',
    '/docs',
    '/docs/api',
    '/blog',
    '/changelog',
    '/events',
    '/privacy',
    '/terms',
    '/refunds',
    '/organizer-agreement',
  ];

  /*
    Each page listed once, with its other language declared as an alternate.

    Listing `/pricing` and `/fr-CA/pricing` as two unrelated entries would have a search
    engine treat them as competing duplicates of the same content. `alternates.languages` is
    what says "same page, other language" — it is how a French speaker searching in French
    gets sent to the French URL rather than to the English one with a translate banner.

    `x-default` points at the unprefixed URL, which is what the middleware serves to somebody
    whose language we cannot determine.
  */
  const languages = (path: string) =>
    Object.fromEntries([
      ...LOCALES.map((l) => [
        l,
        l === DEFAULT_LOCALE ? `${SITE_URL}${path}` : `${SITE_URL}/${l}${path}`,
      ]),
      ['x-default', `${SITE_URL}${path}`],
    ]);

  const staticEntries: MetadataRoute.Sitemap = routes.map((r) => ({
    url: `${SITE_URL}${r}`,
    lastModified: now,
    changeFrequency: r === '' ? 'daily' : 'weekly',
    priority: r === '' ? 1 : r === '/pricing' || r === '/features' ? 0.9 : 0.7,
    alternates: { languages: languages(r) },
  }));

  const blogEntries: MetadataRoute.Sitemap = POSTS.map((p) => ({
    url: `${SITE_URL}/blog/${p.slug}`,
    lastModified: new Date(p.date),
    changeFrequency: 'monthly',
    priority: 0.6,
  }));

  return [...staticEntries, ...blogEntries];
}
