import type { MetadataRoute } from 'next';
import { canonicalSiteUrl } from '@/lib/site-url';
import { buildRobots } from '@/lib/robots-rules';
import { isIndexable } from '@/lib/seo';

/** robots.txt. The rules live in `lib/robots-rules.ts`, where the tests can reach them. */
export default function robots(): MetadataRoute.Robots {
  return buildRobots({ indexable: isIndexable(), siteUrl: canonicalSiteUrl() });
}
