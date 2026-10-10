import type { Metadata } from 'next';
import './globals.css';
import { WebProviders, workspaceThemeScript } from '@eticketsgo/web-kit';
// Self-hosted, so `next build` never downloads fonts; the display face is for titles only.
import { inter } from '@eticketsgo/web-kit/fonts/inter';
import { display } from '@eticketsgo/web-kit/fonts/display';

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
