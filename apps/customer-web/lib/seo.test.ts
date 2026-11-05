import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOME_DESCRIPTION,
  HOME_TITLE,
  alternatesFor,
  isIndexable,
  languageAlternates,
  localizedMetadata,
  localizedPath,
  publicPageMetadata,
  shareCards,
  siteRobots,
} from './seo';

afterEach(() => vi.unstubAllEnvs());

describe('localizedPath', () => {
  it('keeps English unprefixed and puts French under /fr-CA', () => {
    expect(localizedPath('en', '/events/jazz-night')).toBe('/events/jazz-night');
    expect(localizedPath('fr-CA', '/events/jazz-night')).toBe('/fr-CA/events/jazz-night');
  });

  it('handles the home page in both languages', () => {
    expect(localizedPath('en', '/')).toBe('/');
    expect(localizedPath('en', '')).toBe('/');
    expect(localizedPath('fr-CA', '/')).toBe('/fr-CA');
  });

  it('treats an unknown locale as the default rather than inventing a prefix', () => {
    expect(localizedPath('de', '/about')).toBe('/about');
    expect(localizedPath(undefined, '/about')).toBe('/about');
  });
});

describe('alternatesFor', () => {
  it('each page is its own canonical, never the home page', () => {
    expect(alternatesFor('en', '/events/jazz-night')?.canonical).toBe('/events/jazz-night');
    expect(alternatesFor('en', '/movies/dune')?.canonical).toBe('/movies/dune');
    expect(alternatesFor('en', '/events')?.canonical).toBe('/events');
  });

  it('a French page is canonical to its French URL', () => {
    expect(alternatesFor('fr-CA', '/movies/dune')?.canonical).toBe('/fr-CA/movies/dune');
  });

  it('lists en, fr-CA and x-default the same way the sitemap does', () => {
    expect(alternatesFor('fr-CA', '/about')?.languages).toEqual({
      en: '/about',
      'fr-CA': '/fr-CA/about',
      'x-default': '/about',
    });
    expect(languageAlternates('/', 'https://www.eticketsgo.com')).toEqual({
      en: 'https://www.eticketsgo.com/',
      'fr-CA': 'https://www.eticketsgo.com/fr-CA',
      'x-default': 'https://www.eticketsgo.com/',
    });
  });
});

describe('shareCards', () => {
  it('always carries site name, own URL, locale and an image', () => {
    const cards = shareCards({ locale: 'fr-CA', path: '/about', title: 'About - ETicketsGo' });
    expect(cards.openGraph).toMatchObject({
      siteName: 'ETicketsGo',
      url: '/fr-CA/about',
      locale: 'fr_CA',
      alternateLocale: ['en_US'],
      title: 'About - ETicketsGo',
      description: HOME_DESCRIPTION,
    });
    expect(cards.openGraph?.images).toEqual([expect.objectContaining({ url: '/opengraph-image' })]);
    expect(cards.twitter).toMatchObject({ card: 'summary_large_image' });
  });

  it('uses a page picture when there is one', () => {
    const cards = shareCards({
      locale: 'en',
      path: '/events/x',
      title: 'X',
      images: [{ url: 'https://api.example.test/img.jpg' }],
    });
    expect(cards.openGraph?.images).toEqual([{ url: 'https://api.example.test/img.jpg' }]);
  });

  it('never carries the organizer pitch', () => {
    const cards = shareCards({ locale: 'en', path: '/', title: HOME_TITLE });
    expect(JSON.stringify(cards)).not.toMatch(/Sell tickets|check in guests|organizers/i);
  });
});

describe('localizedMetadata', () => {
  it('keeps the page metadata and adds the locale-aware canonical', async () => {
    const generate = localizedMetadata('/pricing', { title: 'Pricing', description: 'Fees.' });
    const meta = await generate({ params: Promise.resolve({ locale: 'fr-CA' }) });
    expect(meta.title).toBe('Pricing');
    expect(meta.alternates?.canonical).toBe('/fr-CA/pricing');
    expect(meta.openGraph).toMatchObject({ title: 'Pricing - ETicketsGo', description: 'Fees.' });
  });

  it('the home page title and description are exactly the owner text', () => {
    const meta = publicPageMetadata('en', '/', {
      title: { absolute: HOME_TITLE },
      description: HOME_DESCRIPTION,
    });
    expect(HOME_TITLE).toBe('ETicketsGo | Discover & Book Movies, Events and Experiences');
    expect(HOME_DESCRIPTION).toBe(
      'Discover and book tickets for movies, concerts, comedy shows, sports, workshops and events with ETicketsGo.',
    );
    expect(meta.alternates?.canonical).toBe('/');
    expect(meta.openGraph).toMatchObject({ title: HOME_TITLE, url: '/' });
  });
});

describe('isIndexable / siteRobots', () => {
  it('production configuration => index, follow', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://www.eticketsgo.com');
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', '');
    expect(isIndexable()).toBe(true);
    expect(siteRobots()).toEqual({ index: true, follow: true });
  });

  it('QA configuration => noindex, nofollow', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://qa.eticketsgo.com');
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'QA');
    expect(isIndexable()).toBe(false);
    expect(siteRobots()).toEqual({ index: false, follow: false });
  });
});
