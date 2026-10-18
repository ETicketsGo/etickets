import type { Metadata } from 'next';
import { inter } from '@eticketsgo/web-kit/fonts/inter';
import { brandDisplay } from '@eticketsgo/web-kit/fonts/brand-display';
import { NotFoundInShell } from '@/components/not-found-shell';
import { serverSessionHint } from '@/lib/session-hint';
import { buildId } from '@/lib/build-id';

export const metadata: Metadata = {
  title: 'Page not found',
  robots: { index: false, follow: true },
};

/**
 * The 404 for a URL that no locale can claim (a path the locale middleware never sees, such as
 * one with a dot in it).
 *
 * The locale layout owns `<html>` and refuses an unknown locale with `notFound()` BEFORE it
 * renders one, so the page that answered was Next's bare error shell: `<html>` with no `lang`
 * (WCAG 3.1.1, axe `html-has-lang`). A 404 outside any locale has no language to take, so it
 * is English - the default locale - and says so.
 *
 * ── THE SAME SHELL AS EVERY OTHER PAGE ─────────────────────────────────────────────
 * It used to be a bare page in the old system: no header, no footer, so no search and no legal
 * line. It now sets up what the locale layout sets up - the English messages, the providers,
 * the site chrome - and draws the same 404 as `[locale]/not-found.tsx` inside it
 * (`NotFoundInShell`).
 */
export default async function RootNotFound() {
  const signedInHint = await serverSessionHint();
  return (
    <html lang="en" className={`${inter.variable} ${brandDisplay.variable}`}>
      <body
        // The locale layout's font variable is not available out here in every build, and an unset
        // variable drops the whole declaration to the browser's serif. Named stack instead.
        style={{ fontFamily: 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' }}
      >
        <NotFoundInShell initialSignedIn={signedInHint} buildId={buildId()} />
      </body>
    </html>
  );
}
