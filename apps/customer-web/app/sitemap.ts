import type { MetadataRoute } from 'next';
import { POSTS } from '@/lib/blog';
import { canonicalSiteUrl } from '@/lib/site-url';
import { isIndexable } from '@/lib/seo';
import { buildSitemap } from '@/lib/sitemap-entries';
import { runtimeValue } from '@eticketsgo/web-kit/runtime-config';

/** Rebuilt at most once an hour, so new events appear without a deploy. */
export const revalidate = 3600;

const BUILD_API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api';
/** The running environment's API base (runtime-config.ts), else this build's. */
const apiBase = () => runtimeValue('API_URL', BUILD_API) ?? BUILD_API;

/** sitemap.xml. What it lists, and what it leaves out, is in `lib/sitemap-entries.ts`. */
export default function sitemap(): Promise<MetadataRoute.Sitemap> {
  return buildSitemap({
    indexable: isIndexable(),
    siteUrl: canonicalSiteUrl(),
    apiUrl: apiBase(),
    fetcher: (url) =>
      fetch(url, { next: { revalidate }, signal: AbortSignal.timeout(10_000) } as RequestInit),
    blogPosts: POSTS,
  });
}
