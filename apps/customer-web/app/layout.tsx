import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';
import { Header } from '@/components/header';
import { FeedbackWidget } from '@/components/feedback-widget';
import { SwRegister } from '@/components/sw-register';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: 'ETicketsGo — Discover & book events',
  description: 'Find events, book tickets, and get instant QR passes.',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'ETicketsGo', statusBarStyle: 'default' },
  icons: { icon: '/icon.svg', apple: '/icon.svg' },
};

export const viewport: Viewport = {
  themeColor: '#4f46e5',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <Providers>
          <Header />
          <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">{children}</main>
          <footer className="mt-16 border-t border-border py-8 text-center text-caption text-text-muted">
            ETicketsGo — demo MVP. Mock payments only.
          </footer>
          <FeedbackWidget />
          <SwRegister />
        </Providers>
      </body>
    </html>
  );
}
