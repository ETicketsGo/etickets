import type { MetadataRoute } from 'next';
import { POSTS } from '@/lib/blog';
import { canonicalSiteUrl } from '@/lib/site-url';
import { isIndexable } from '@/lib/seo';
import { buildSitemap } from '@/lib/sitemap-entries';

/** Rebuilt at most once an hour, so new events appear without a deploy. */
export const revalidate = 3600;

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api';

/** sitemap.xml. What it lists, and what it leaves out, is in `lib/sitemap-entries.ts`. */
export default function sitemap(): Promise<MetadataRoute.Sitemap> {
  return buildSitemap({
    indexable: isIndexable(),
    siteUrl: canonicalSiteUrl(),
    apiUrl: API,
    fetcher: (url) =>
      fetch(url, { next: { revalidate }, signal: AbortSignal.timeout(10_000) } as RequestInit),
    blogPosts: POSTS,
  });
}
