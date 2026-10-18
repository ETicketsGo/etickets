import type { Metadata } from 'next';
import './globals.css';
import { WebProviders, workspaceThemeScript } from '@eticketsgo/web-kit';
// Self-hosted, so `next build` never downloads fonts; the display face is for titles only.
import { inter } from '@eticketsgo/web-kit/fonts/inter';
import { display } from '@eticketsgo/web-kit/fonts/display';

export const metadata: Metadata = {
  title: 'ETicketsGo — Admin',
  description: 'Platform administration: organizers, events, refunds, payouts, and audit.',
  manifest: '/manifest.webmanifest',
  /*
    Drawn by scripts/brand/generate-favicons.mjs. The admin tile is marigold, the loudest of the
    three, because a click in the wrong tab costs most here.
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
      <body>
        {/*
          WHY THIS IS IN <body> AND NOT IN AN EXPLICIT <head>: a <head> element in this layout
          puts a non-hoistable child (this script) in the document head, and React then has to
          walk the head during hydration. Next puts its own <meta charset> there, so about one
          load in ten (QA, Chromium 390) React met that meta first, took it for the script, and
          threw error #418 - and the client re-render that follows discards the `dark` class this
          script set, so the console fell back to light. Without a <head> here Next owns the
          head and the script is body content, which hydrates by position. It still runs before
          the first paint: the parser executes it before reading the markup below it.
        */}
        <script dangerouslySetInnerHTML={{ __html: workspaceThemeScript }} />
        <WebProviders>{children}</WebProviders>
      </body>
    </html>
  );
}
