import type { Metadata } from 'next';
import Link from 'next/link';
import { Wordmark } from '@eticketsgo/web-kit';

export const metadata: Metadata = {
  title: 'Page not found',
  robots: { index: false, follow: false },
};

/**
 * The console's 404. It was Next's bare "404 | This page could not be found" in a system font:
 * no brand and no way back. Now the wordmark, one sentence, and the way home (the console sends
 * a signed-out visitor on to sign in).
 */
export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background-canvas p-6">
      <div className="w-full max-w-sm text-center">
        <Wordmark size="lg" tone="auto" product="Admin" />
        <h1 className="mt-8 text-h3 font-bold tracking-tight text-text-primary">Page not found</h1>
        <p className="mt-2 text-[0.9375rem] text-text-muted">
          This address is not a page in the console. It may be an old link.
        </p>
        <Link
          href="/admin"
          className="mt-6 inline-flex min-h-11 items-center justify-center rounded-md bg-action-primary px-5 text-ui font-semibold text-action-primary-foreground hover:bg-action-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Go to the dashboard
        </Link>
      </div>
    </main>
  );
}
