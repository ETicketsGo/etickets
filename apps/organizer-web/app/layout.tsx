import type { Metadata } from 'next';
import './globals.css';
import { WebProviders, workspaceThemeScript } from '@eticketsgo/web-kit';
// Self-hosted, so `next build` never downloads fonts; the display face is for titles only.
import { inter } from '@eticketsgo/web-kit/fonts/inter';
import { display } from '@eticketsgo/web-kit/fonts/display';

export const metadata: Metadata = {
  title: 'ETicketsGo — Organizer',
  description: 'Create events, manage orders, check in attendees, and track revenue.',
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
          Runs before the first paint, so a workspace opens in its own colours rather than
          flashing the platform's and correcting itself. React applies both in effects, which
          run after paint — on a dark-mode console that is a white flash on every navigation,
          which is the difference between an application and a web page.

          `suppressHydrationWarning` on <html> because this script deliberately changes the
          element's class and attributes before React hydrates; without it React reports a
          mismatch for markup it was always going to be handed.
        */}
        <script dangerouslySetInnerHTML={{ __html: workspaceThemeScript }} />
      </head>
      <body>
        <WebProviders>{children}</WebProviders>
      </body>
    </html>
  );
}
