import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { HTML_LANG, type Locale } from '@eticketsgo/i18n';
import { routing } from '@/i18n/routing';
import { Providers } from '../providers';
import { SiteChrome } from '@/components/site-chrome';
import { SkipToContent } from '@/components/skip-to-content';
import { SwRegister } from '@/components/sw-register';
import { serverSessionHint } from '@/lib/session-hint';
import { buildId } from '@/lib/build-id';
// Self-hosted, so `next build` never downloads fonts.
import { inter } from '@eticketsgo/web-kit/fonts/inter';
// The brand layer's display face (DESIGN-SYSTEM.md). Only sets --font-brand-display; nothing
// renders in it until a page opts into `data-brand`.
import { brandDisplay } from '@eticketsgo/web-kit/fonts/brand-display';
import { PLATFORM_OPERATOR, PUBLISHED_SUPPORT_EMAIL } from '@eticketsgo/shared-types';
import { canonicalSiteUrl } from '@/lib/site-url';
import {
  HOME_DESCRIPTION,
  HOME_TITLE,
  SHARE_IMAGE,
  SITE_NAME,
  TWITTER_IMAGE,
  siteRobots,
} from '@/lib/seo';
import { TITLE_TEMPLATE } from '@/lib/page-title';
import { buildOrganizationJsonLd, buildWebSiteJsonLd } from '@/lib/structured-data';
import { JsonLd } from '@/components/json-ld';

const SITE_URL = canonicalSiteUrl();

/*
  A function rather than a constant so the build id is read when the request is handled, by the
  process that is answering it. See `lib/build-id.ts`.
*/
export function generateMetadata(): Metadata {
  const build = buildId();
  return { ...metadata, ...(build ? { other: { 'build-id': build } } : {}) };
}

/*
  The storefront's defaults, written for the people who buy tickets.

  These used to be the pitch to ORGANIZERS ("Sell tickets, check in guests, see your sales"),
  so every buyer's page that did not set its own carried it into search results and shared
  links. Organizer acquisition keeps its own pages (/organizers, /sell) with their own words.

  There is deliberately no `alternates.canonical` here. One set at this level is inherited by
  every page that does not set its own, and it was '/': every event and film page told search
  engines the home page was the real version of it. Each page names itself instead
  (`lib/seo.ts`).
*/
const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: HOME_TITLE, template: TITLE_TEMPLATE },
  description: HOME_DESCRIPTION,
  applicationName: SITE_NAME,
  authors: [{ name: SITE_NAME }],
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: SITE_NAME, statusBarStyle: 'default' },
  /*
    Drawn by scripts/brand/generate-favicons.mjs. The storefront's mark is the wordmark's own
    ending: an ink E and the marigold full stop, on paper.
    The SVG is what current browsers pick; the ICO and PNGs are for the ones that ask for
    /favicon.ico or a fixed size, and the apple icon is what iOS puts on a home screen.
  */
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '16x16 32x32 48x48' },
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icon-16.png', sizes: '16x16', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
  },
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
    images: [SHARE_IMAGE],
  },
  twitter: {
    card: 'summary_large_image',
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
    images: [TWITTER_IMAGE],
  },
  /*
    Indexable only on the production storefront; QA, UAT and anything unconfigured say
    noindex (`lib/indexability.mjs`). A page that must never be indexed sets its own.
  */
  robots: siteRobots(),
};

/*
  Who we are and how to search the site, for search engines. Facts from the entity registry
  and the published support address only; nothing here is a guess.
*/
const SITE_JSON_LD = [
  buildOrganizationJsonLd({
    siteUrl: SITE_URL,
    legalName: PLATFORM_OPERATOR.legalName,
    email: PUBLISHED_SUPPORT_EMAIL,
  }),
  buildWebSiteJsonLd({ siteUrl: SITE_URL }),
];

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F6F2EA' },
    { media: '(prefers-color-scheme: dark)', color: '#16130F' },
  ],
  /*
    ── WITHOUT THIS, EVERY SAFE-AREA INSET IS ZERO ──────────────────────────────────
    The header, the bottom bar, the install prompt and the seat-selection pay bar all reserve
    room with `env(safe-area-inset-*)`. Measured in the installed app on a real phone, every
    one of those resolved to `0px`, because a viewport that has not opted into covering the
    display cutout is never given insets to report. The padding was dead code.

    It also cost the app the screen it was installed to fill: the window measured 873px inside
    a 915px display, and the 42px difference was a black band under the gesture bar. An app
    letterboxed inside its own window does not read as an app.

    Opting in means content can now reach under the status bar and the gesture bar, which is
    exactly why the insets above have to be honoured - and they are, everywhere something is
    pinned to an edge.
  */
  viewportFit: 'cover',
};

/**
 * Pre-render both languages at build time rather than resolving on every request.
 *
 * Without this the storefront becomes dynamic the moment `setRequestLocale` is called, and a
 * ticketing site's event pages are exactly the thing that should be static and cacheable.
 */
export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  /*
    A locale we do not ship is a 404, not a silent fallback to English.

    `/de/events` rendering the English page would tell a search engine that a German URL
    exists and serve it English content — and it would hide a typo in a link rather than
    surfacing it.
  */
  if (!hasLocale(routing.locales, locale)) notFound();
  /*
    Which shell to draw, decided before the first byte leaves.

    A hint, never a credential - see `serverSessionHint`. It exists so a signed-in customer
    does not get the marketing header and landing page on first paint and a corrective render a
    moment later, which is what "I can see the regular landing page for just micro seconds" was.
  */
  const signedInHint = await serverSessionHint();
  setRequestLocale(locale);

  return (
    /*
      `lang` follows the content. It is what makes a screen reader use a French voice for
      French text — WCAG 3.1.1, the criterion the accessibility sweep asserts on every route
      — and what tells a browser which hyphenation and quotation rules to apply.
    */
    <html
      lang={HTML_LANG[locale as Locale]}
      className={`${inter.variable} ${brandDisplay.variable}`}
    >
      <head>
        <JsonLd data={SITE_JSON_LD} />
      </head>
      <body>
        <NextIntlClientProvider>
          <SkipToContent />
          <Providers>
            <SiteChrome initialSignedIn={signedInHint} buildId={buildId()}>
              {children}
            </SiteChrome>
            <SwRegister />
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
