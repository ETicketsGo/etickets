import type { Metadata } from 'next';
import Link from 'next/link';
import { inter } from '@eticketsgo/web-kit/fonts/inter';
import { brandDisplay } from '@eticketsgo/web-kit/fonts/brand-display';

export const metadata: Metadata = {
  title: 'Page not found',
  robots: { index: false, follow: true },
};

/**
 * The 404 for a URL that no locale can claim ("/zzz", "/xx/events").
 *
 * The locale layout owns `<html>` and refuses an unknown locale with `notFound()` BEFORE it
 * renders one, so the page that answered was Next's bare error shell: `<html>` with no `lang`
 * (WCAG 3.1.1, axe `html-has-lang`). A 404 outside any locale has no language to take, so it
 * is English - the default locale - and says so. A 404 INSIDE a locale still renders in the
 * layout, with the site chrome, from `[locale]/not-found.tsx`.
 *
 * Next's own Link, not the localized one: there is no intl provider out here to read a locale from.
 */
export default function RootNotFound() {
  return (
    <html lang="en" className={`${inter.variable} ${brandDisplay.variable}`}>
      <body
        // The locale layout's font variable is not available out here in every build, and an unset
        // variable drops the whole declaration to the browser's serif. Named stack instead.
        style={{ fontFamily: 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' }}
      >
        <main className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center px-4 py-24 text-center">
          <h1 className="text-3xl font-bold tracking-tight text-text-primary">
            This page took a different exit
          </h1>
          <p className="mt-3 text-[0.9375rem] leading-relaxed text-text-secondary">
            The page you are looking for does not exist or may have moved.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/"
              className="inline-flex min-h-11 items-center justify-center rounded-md bg-action-primary px-5 text-[0.9375rem] font-semibold text-action-primary-foreground"
            >
              Back to home
            </Link>
            <Link
              href="/events"
              className="inline-flex min-h-11 items-center justify-center rounded-md border border-border px-5 text-[0.9375rem] font-semibold text-text-primary"
            >
              Browse events
            </Link>
          </div>
        </main>
      </body>
    </html>
  );
}
