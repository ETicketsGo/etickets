import { describe, expect, it, vi } from 'vitest';
import {
  EXCLUDED_ROUTES,
  MAX_EVENT_PAGES,
  buildSitemap,
  publicEventSlugs,
} from './sitemap-entries';

const SITE = 'https://www.eticketsgo.com';
const API = 'https://api.test/api';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fake public API: what the real one returns for published, public items. */
function fakeApi(): (url: string) => Promise<Response> {
  return async (url: string) => {
    if (url.startsWith(`${API}/public/events?page=1`)) {
      return json({
        data: [
          { slug: 'jazz-night' },
          { slug: 'comedy-hour' },
          { slug: 'qa-fixture', contentLabel: 'TEST' },
        ],
        meta: { page: 1, pageSize: 100, total: 4, totalPages: 2 },
      });
    }
    if (url.startsWith(`${API}/public/events?page=2`)) {
      return json({ data: [{ slug: 'food-fest' }], meta: { totalPages: 2 } });
    }
    if (url === `${API}/public/movies`) return json([{ slug: 'dune' }, { slug: '' }]);
    return json({ message: 'not found' }, 404);
  };
}

const urls = (s: { url: string }[]) => s.map((e) => e.url);

describe('buildSitemap', () => {
  it('lists the public pages and only published public events and films from the API', async () => {
    const sitemap = await buildSitemap({
      indexable: true,
      siteUrl: SITE,
      apiUrl: API,
      fetcher: fakeApi(),
      blogPosts: [{ slug: 'hello', date: '2026-07-10' }],
    });
    const list = urls(sitemap);
    expect(list).toContain(`${SITE}/`);
    expect(list).toContain(`${SITE}/events`);
    expect(list).toContain(`${SITE}/events/jazz-night`);
    expect(list).toContain(`${SITE}/events/comedy-hour`);
    expect(list).toContain(`${SITE}/events/food-fest`);
    expect(list).toContain(`${SITE}/movies/dune`);
    expect(list).toContain(`${SITE}/blog/hello`);
    // Labelled test content and an empty slug are never listed.
    expect(list).not.toContain(`${SITE}/events/qa-fixture`);
    expect(list).not.toContain(`${SITE}/movies/`);
    // Every URL is on the site's own host.
    expect(list.every((u) => u.startsWith(`${SITE}/`))).toBe(true);
    expect(new Set(list).size).toBe(list.length);
  });

  it('never lists noindex or private pages', async () => {
    const list = urls(
      await buildSitemap({ indexable: true, siteUrl: SITE, apiUrl: API, fetcher: fakeApi() }),
    );
    for (const route of EXCLUDED_ROUTES) {
      expect(list).not.toContain(`${SITE}${route}`);
      expect(list.some((u) => u.startsWith(`${SITE}${route}/`))).toBe(false);
    }
  });

  it('does not claim every page changed just now', async () => {
    const sitemap = await buildSitemap({
      indexable: true,
      siteUrl: SITE,
      apiUrl: API,
      fetcher: fakeApi(),
    });
    expect(sitemap.every((e) => e.lastModified === undefined)).toBe(true);
  });

  it('declares each page in both languages', async () => {
    const sitemap = await buildSitemap({
      indexable: true,
      siteUrl: SITE,
      apiUrl: API,
      fetcher: fakeApi(),
    });
    const event = sitemap.find((e) => e.url === `${SITE}/events/jazz-night`);
    expect(event?.alternates?.languages).toEqual({
      en: `${SITE}/events/jazz-night`,
      'fr-CA': `${SITE}/fr-CA/events/jazz-night`,
      'x-default': `${SITE}/events/jazz-night`,
    });
  });

  it('survives the API failing: static pages only, no throw', async () => {
    const down = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const sitemap = await buildSitemap({
      indexable: true,
      siteUrl: SITE,
      apiUrl: API,
      fetcher: down,
    });
    const list = urls(sitemap);
    expect(list).toContain(`${SITE}/`);
    expect(list.some((u) => u.includes('/events/'))).toBe(false);

    const broken = vi.fn(async () => json({ message: 'boom' }, 500));
    const again = await buildSitemap({
      indexable: true,
      siteUrl: SITE,
      apiUrl: API,
      fetcher: broken,
    });
    expect(urls(again)).toContain(`${SITE}/events`);
  });

  it('is empty when the deployment is not production', async () => {
    const fetcher = vi.fn(fakeApi());
    const sitemap = await buildSitemap({
      indexable: false,
      siteUrl: 'https://qa.eticketsgo.com',
      apiUrl: API,
      fetcher,
    });
    expect(sitemap).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('publicEventSlugs', () => {
  it('stops at the page cap even if the API reports more pages', async () => {
    const fetcher = vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get('page'));
      return json({ data: [{ slug: `e-${page}` }], meta: { totalPages: 999 } });
    });
    const slugs = await publicEventSlugs(API, fetcher);
    expect(slugs).toHaveLength(MAX_EVENT_PAGES);
    expect(fetcher).toHaveBeenCalledTimes(MAX_EVENT_PAGES);
  });
});
