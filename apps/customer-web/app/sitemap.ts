import type { MetadataRoute } from 'next';
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

  const staticEntries: MetadataRoute.Sitemap = routes.map((r) => ({
    url: `${SITE_URL}${r}`,
    lastModified: now,
    changeFrequency: r === '' ? 'daily' : 'weekly',
    priority: r === '' ? 1 : r === '/pricing' || r === '/features' ? 0.9 : 0.7,
  }));

  const blogEntries: MetadataRoute.Sitemap = POSTS.map((p) => ({
    url: `${SITE_URL}/blog/${p.slug}`,
    lastModified: new Date(p.date),
    changeFrequency: 'monthly',
    priority: 0.6,
  }));

  return [...staticEntries, ...blogEntries];
}
