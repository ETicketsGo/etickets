import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import '../globals.css';
import { notFound } from 'next/navigation';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { HTML_LANG, type Locale } from '@eticketsgo/i18n';
import { routing } from '@/i18n/routing';
import { Providers } from '../providers';
import { SiteChrome } from '@/components/site-chrome';
import { SkipToContent } from '@/components/skip-to-content';
import { SwRegister } from '@/components/sw-register';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://eticketsgo.com';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'ETicketsGo: Sell tickets, check in guests, see your sales',
    template: '%s - ETicketsGo',
  },
  description:
    'ETicketsGo is ticketing software for event organizers. Sell tickets, reserve seats, take payments, scan people in at the gate, and read your sales reports.',
  applicationName: 'ETicketsGo',
  keywords: [
    'event ticketing',
    'sell tickets online',
    'reserved seating',
    'offline check-in',
    'event management platform',
    'box office software',
  ],
  authors: [{ name: 'ETicketsGo' }],
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'ETicketsGo', statusBarStyle: 'default' },
  icons: { icon: '/icon.svg', apple: '/icon.svg' },
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: 'ETicketsGo',
    title: 'ETicketsGo: Sell tickets, check in guests, see your sales',
    description:
      'Ticketing software for event organizers. Tickets, seating, payments, offline check-in and sales reports.',
    url: SITE_URL,
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ETicketsGo: Ticketing software for event organizers',
    description:
      'Tickets, reserved seating, payments, offline gate check-in and sales reports in one place.',
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0B0E15' },
  ],
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
  setRequestLocale(locale);

  return (
    /*
      `lang` follows the content. It is what makes a screen reader use a French voice for
      French text — WCAG 3.1.1, the criterion the accessibility sweep asserts on every route
      — and what tells a browser which hyphenation and quotation rules to apply.
    */
    <html lang={HTML_LANG[locale as Locale]} className={inter.variable}>
      <body>
        <NextIntlClientProvider>
          <SkipToContent />
          <Providers>
            <SiteChrome>{children}</SiteChrome>
            <SwRegister />
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
