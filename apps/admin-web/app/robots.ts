import type { MetadataRoute } from 'next';

/*
  The admin console is never meant to be found: no crawler, every path. This only keeps honest
  crawlers out of search results; it is NOT a security control (anyone can ignore it). The
  access gate (middleware.ts) and the console's own sign-in are what protect it.
*/
export const dynamic = 'force-static';

export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: '*', disallow: '/' }] };
}
