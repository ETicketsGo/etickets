import type { Metadata } from 'next';
import { Inter, Plus_Jakarta_Sans } from 'next/font/google';
import './globals.css';
import { WebProviders, workspaceThemeScript } from '@eticketsgo/web-kit';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
/*
  The console's display face: page titles and the big numbers only (DESIGN-DIRECTION). Inter
  stays the face for everything a person reads at length.
*/
const display = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-display',
  weight: ['600', '700'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'ETicketsGo — Admin',
  description: 'Platform administration: organizers, events, refunds, payouts, and audit.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // `data-console` gives the operator consoles their teal accent; see tokens.css. The
    // storefront never sets it, which is what keeps its blue unchanged.
    <html
      lang="en"
      className={`${inter.variable} ${display.variable}`}
      data-console=""
      suppressHydrationWarning
    >
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
