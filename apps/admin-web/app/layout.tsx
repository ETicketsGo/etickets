import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { WebProviders, workspaceThemeScript } from '@eticketsgo/web-kit';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: 'ETicketsGo — Admin',
  description: 'Platform administration: organizers, events, refunds, payouts, and audit.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        {/*
          The same blocking script the organizer console runs, so a dark-mode choice is applied
          before the first paint instead of flashing white on every load. The admin console has
          no organization accent, so only the light/dark half of it does anything here.
          `suppressHydrationWarning` because the script changes <html>'s class before React
          hydrates, on purpose.
        */}
        <script dangerouslySetInnerHTML={{ __html: workspaceThemeScript }} />
      </head>
      <body>
        <WebProviders>{children}</WebProviders>
      </body>
    </html>
  );
}
