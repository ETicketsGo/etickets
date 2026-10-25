import type { Metadata } from 'next';
import { DEFAULT_LOCALE, LOCALES, type Locale } from '@eticketsgo/i18n';
import { isIndexableDeployment } from './indexability.mjs';
import { TITLE_TEMPLATE } from './page-title';

/**
 * Search and sharing metadata for storefront pages, in one place.
 *
 * -- WHAT WAS WRONG ---------------------------------------------------------------------
 * The locale layout declared `alternates: { canonical: '/' }`, and every page that did not
 * set its own inherited it: each event page, each film page, the listings, sign-in and
 * checkout all told search engines "the real version of this page is the home page". The
 * pages that did set one set the English path, so the French page named the English one
 * as canonical. And the sharing card on a buyer's page carried the pitch to organizers.
 *
 * Every page now names ITSELF, in its own language, lists its other language, and shares
 * as what it is.
 */

export const SITE_NAME = 'ETicketsGo';

/** The home page's title and description, exactly as the owner set them. */
export const HOME_TITLE = 'ETicketsGo | Discover & Book Movies, Events and Experiences';
export const HOME_DESCRIPTION =
  'Discover and book tickets for movies, concerts, comedy shows, sports, workshops and events with ETicketsGo.';

/** The sharing card drawn by `app/opengraph-image.tsx` and `app/twitter-image.tsx`. */
export const SHARE_IMAGE = {
  url: '/opengraph-image',
  width: 1200,
  height: 630,
  alt: 'ETicketsGo - discover and book movies, events and experiences',
};
export const TWITTER_IMAGE = { ...SHARE_IMAGE, url: '/twitter-image' };

/** Open Graph wants language_TERRITORY. */
export const OG_LOCALE: Record<Locale, string> = { en: 'en_US', 'fr-CA': 'fr_CA' };

/** For pages nobody should find in a search engine: sign-in, checkout, an account. */
export const PRIVATE_ROBOTS = { index: false, follow: false } as const;

/** Is THIS build the production storefront? See `lib/indexability.mjs`. */
export function isIndexable(): boolean {
  // The literal `process.env.NEXT_PUBLIC_*` reads are what Next inlines at build time.
  return isIndexableDeployment({
    siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
    appEnv: process.env.NEXT_PUBLIC_APP_ENV,
  });
}

/** The robots metadata for a public page on this build. */
export function siteRobots(indexable: boolean = isIndexable()): Metadata['robots'] {
  return indexable ? { index: true, follow: true } : { index: false, follow: false };
}

function asLocale(locale: string | undefined): Locale {
  return (LOCALES as readonly string[]).includes(locale ?? '')
    ? (locale as Locale)
    : DEFAULT_LOCALE;
}

/**
 * `path` as it appears in `locale`: English unprefixed, French under `/fr-CA`.
 * `''` and `'/'` both mean the home page.
 */
export function localizedPath(locale: string | undefined, path: string): string {
  const clean = path === '/' ? '' : path.replace(/\/+$/, '');
  const l = asLocale(locale);
  if (l === DEFAULT_LOCALE) return clean || '/';
  return `/${l}${clean}`;
}

/**
 * Every language of `path`, plus `x-default` (the unprefixed URL, which is what the
 * middleware serves somebody whose language it cannot tell). With an `origin` the URLs are
 * absolute, as the sitemap needs; without one they are paths for `metadataBase`.
 */
export function languageAlternates(path: string, origin = ''): Record<string, string> {
  return Object.fromEntries([
    ...LOCALES.map((l) => [l, `${origin}${localizedPath(l, path)}`]),
    ['x-default', `${origin}${localizedPath(DEFAULT_LOCALE, path)}`],
  ]);
}

/** `alternates` for a page: itself as canonical, in its own language, and its other languages. */
export function alternatesFor(locale: string | undefined, path: string): Metadata['alternates'] {
  return { canonical: localizedPath(locale, path), languages: languageAlternates(path) };
}

/** A page title as plain text for a sharing card, which has no template of its own. */
export function shareTitle(title: Metadata['title'] | undefined): string {
  if (!title) return HOME_TITLE;
  if (typeof title === 'string') return TITLE_TEMPLATE.replace('%s', title);
  if ('absolute' in title && title.absolute) return title.absolute;
  if ('default' in title && title.default) return title.default;
  return HOME_TITLE;
}

export interface ShareImage {
  url: string;
  width?: number;
  height?: number;
  alt?: string;
}

/**
 * The Open Graph and Twitter cards for a page.
 *
 * A child's `openGraph` REPLACES its parent's in Next (the keys are not merged), so a page
 * that set only a title used to lose the site name, the URL and the image. This always
 * returns the whole card.
 */
export function shareCards(input: {
  locale: string | undefined;
  path: string;
  title: string;
  description?: string;
  images?: ShareImage[];
  type?: 'website' | 'article';
}): Pick<Metadata, 'openGraph' | 'twitter'> {
  const locale = asLocale(input.locale);
  const description = input.description ?? HOME_DESCRIPTION;
  const ogImages = input.images?.length ? input.images : [SHARE_IMAGE];
  const twImages = input.images?.length ? input.images : [TWITTER_IMAGE];
  return {
    openGraph: {
      type: input.type ?? 'website',
      siteName: SITE_NAME,
      url: localizedPath(locale, input.path),
      locale: OG_LOCALE[locale],
      alternateLocale: LOCALES.filter((l) => l !== locale).map((l) => OG_LOCALE[l]),
      title: input.title,
      description,
      images: ogImages,
    },
    twitter: {
      card: 'summary_large_image',
      title: input.title,
      description,
      images: twImages,
    },
  };
}

/**
 * Metadata for a public page at `path`: canonical, languages and sharing cards added to
 * what the page declares.
 */
export function publicPageMetadata(
  locale: string | undefined,
  path: string,
  meta: Metadata,
): Metadata {
  const description = typeof meta.description === 'string' ? meta.description : undefined;
  return {
    ...meta,
    alternates: alternatesFor(locale, path),
    ...shareCards({ locale, path, title: shareTitle(meta.title), description }),
  };
}

/**
 * `generateMetadata` for a public page with a fixed path, so a page declares its metadata as
 * it always did and gets the locale-aware canonical for free:
 *
 *   export const generateMetadata = localizedMetadata('/about', { title: 'About', ... });
 */
export function localizedMetadata(path: string, meta: Metadata) {
  return async function generateMetadata({
    params,
  }: {
    params: Promise<{ locale: string }>;
  }): Promise<Metadata> {
    const { locale } = await params;
    return publicPageMetadata(locale, path, meta);
  };
}
