import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';
import { Header } from '@/components/header';
import { FeedbackWidget } from '@/components/feedback-widget';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: 'ETicketsGo — Discover & book events',
  description: 'Find events, book tickets, and get instant QR passes.',
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
        </Providers>
      </body>
    </html>
  );
}
