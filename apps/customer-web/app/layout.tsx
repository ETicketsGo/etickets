import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';
import { SiteChrome } from '@/components/site-chrome';
import { SwRegister } from '@/components/sw-register';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://eticketsgo.com';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'ETicketsGo — Sell tickets, check in guests, understand your events',
    template: '%s · ETicketsGo',
  },
  description:
    'ETicketsGo is the experience-commerce platform for event organizers — ticketing, reserved seating, payments, offline gate check-in, and analytics in one place.',
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
    title: 'ETicketsGo — Sell tickets, check in guests, understand your events',
    description:
      'The experience-commerce platform for event organizers — ticketing, seating, payments, offline check-in, and analytics.',
    url: SITE_URL,
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ETicketsGo — Experience commerce for event organizers',
    description:
      'Ticketing, reserved seating, payments, offline gate check-in, and analytics in one platform.',
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0B0E15' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-lg focus:bg-action-primary focus:px-4 focus:py-2 focus:text-action-primary-foreground"
        >
          Skip to content
        </a>
        <Providers>
          <SiteChrome>{children}</SiteChrome>
          <SwRegister />
        </Providers>
      </body>
    </html>
  );
}
