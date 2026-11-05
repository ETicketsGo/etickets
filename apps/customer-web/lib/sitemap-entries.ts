import type { MetadataRoute } from 'next';
import { languageAlternates } from './seo';

/**
 * What the sitemap lists, and only that.
 *
 * -- WHAT IS LEFT OUT, AND WHY ----------------------------------------------------------
 * - Pages that say noindex (privacy, terms, refunds, the organizer agreement, the API
 *   reference). Listing a page and also telling search engines not to index it is a
 *   contradiction they report as an error.
 * - Private pages (account, checkout, booking, sign-in). They are not content.
 * - Anything the public API does not return. The API lists only PUBLISHED events with a
 *   date still to come and only films with a bookable show, so unpublished, paused, private
 *   or finished items never reach this file. An item the API labels as DEMO or TEST content
 *   (outside production only) is left out too.
 * - A `lastModified` we do not know. It used to be "now" for every page on every request,
 *   which tells a crawler everything changed all the time and so means nothing.
 */
export const STATIC_ROUTES = [
  '',
  '/events',
  '/movies',
  '/explore',
  '/help',
  '/features',
  '/pricing',
  '/solutions',
  '/organizers',
  '/sell',
  '/customers',
  '/about',
  '/contact',
  '/faq',
  '/docs',
  '/blog',
  '/changelog',
  '/legal',
  '/cookies',
  '/sms',
  '/delete-account',
] as const;

/** Never in the sitemap: they say noindex, or they are somebody's own page. */
export const EXCLUDED_ROUTES = [
  '/privacy',
  '/terms',
  '/refunds',
  '/organizer-agreement',
  '/docs/api',
  '/account',
  '/checkout',
  '/booking',
  '/shows',
  '/login',
  '/register',
  '/invite',
  '/share',
  '/reset-password',
  '/forgot-password',
] as const;

/** Upper bounds, so one sitemap can never grow past what one file should hold. */
export const MAX_EVENT_PAGES = 10;
export const EVENT_PAGE_SIZE = 100;
export const MAX_MOVIES = 500;

interface CatalogueItem {
  slug?: string | null;
  contentLabel?: string | null;
}

type Fetcher = (url: string) => Promise<Response>;

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;

function usable(item: CatalogueItem): item is { slug: string } {
  return Boolean(item.slug && SLUG.test(item.slug) && !item.contentLabel);
}

async function getJson(fetcher: Fetcher, url: string): Promise<unknown> {
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

/** Slugs of published, upcoming events, page by page, up to the cap. Empty on any failure. */
export async function publicEventSlugs(apiUrl: string, fetcher: Fetcher): Promise<string[]> {
  const slugs: string[] = [];
  try {
    for (let page = 1; page <= MAX_EVENT_PAGES; page++) {
      const body = (await getJson(
        fetcher,
        `${apiUrl}/public/events?page=${page}&pageSize=${EVENT_PAGE_SIZE}`,
      )) as { data?: CatalogueItem[]; meta?: { totalPages?: number } };
      const rows = Array.isArray(body?.data) ? body.data : [];
      slugs.push(...rows.filter(usable).map((r) => r.slug));
      const totalPages = Number(body?.meta?.totalPages ?? 1);
      if (rows.length === 0 || page >= totalPages) break;
    }
  } catch {
    // Keep what was read before the failure; the static pages still go out.
  }
  return [...new Set(slugs)];
}

/** Slugs of published films with a bookable show. Empty on any failure. */
export async function publicMovieSlugs(apiUrl: string, fetcher: Fetcher): Promise<string[]> {
  try {
    const body = await getJson(fetcher, `${apiUrl}/public/movies`);
    const rows = (Array.isArray(body) ? body : []) as CatalogueItem[];
    return [...new Set(rows.filter(usable).map((r) => r.slug))].slice(0, MAX_MOVIES);
  } catch {
    return [];
  }
}

function entry(
  siteUrl: string,
  path: string,
  extra: Partial<MetadataRoute.Sitemap[number]> = {},
): MetadataRoute.Sitemap[number] {
  return {
    url: `${siteUrl}${path || '/'}`,
    alternates: { languages: languageAlternates(path || '/', siteUrl) },
    ...extra,
  };
}

/**
 * The whole sitemap. Not production: empty, so nothing about a test copy is advertised.
 * The API failing never fails the sitemap: the static pages are listed regardless.
 */
export async function buildSitemap(input: {
  indexable: boolean;
  siteUrl: string;
  apiUrl: string;
  fetcher: Fetcher;
  blogPosts?: { slug: string; date: string }[];
}): Promise<MetadataRoute.Sitemap> {
  if (!input.indexable) return [];
  const { siteUrl } = input;

  const statics = STATIC_ROUTES.map((r) =>
    entry(siteUrl, r, {
      changeFrequency: r === '' || r === '/events' || r === '/movies' ? 'daily' : 'weekly',
      priority: r === '' ? 1 : r === '/events' || r === '/movies' ? 0.9 : 0.6,
    }),
  );

  const blog = (input.blogPosts ?? []).map((p) => {
    const date = new Date(p.date);
    return {
      url: `${siteUrl}/blog/${p.slug}`,
      ...(Number.isNaN(date.getTime()) ? {} : { lastModified: date }),
      changeFrequency: 'monthly' as const,
      priority: 0.5,
    };
  });

  const [events, movies] = await Promise.all([
    publicEventSlugs(input.apiUrl, input.fetcher),
    publicMovieSlugs(input.apiUrl, input.fetcher),
  ]);
  const eventEntries = events.map((slug) =>
    entry(siteUrl, `/events/${slug}`, { changeFrequency: 'daily', priority: 0.8 }),
  );
  const movieEntries = movies.map((slug) =>
    entry(siteUrl, `/movies/${slug}`, { changeFrequency: 'daily', priority: 0.8 }),
  );

  return [...statics, ...eventEntries, ...movieEntries, ...blog];
}
