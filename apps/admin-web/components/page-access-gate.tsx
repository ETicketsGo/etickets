'use client';

import { type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuthUser } from '@eticketsgo/web-kit';
import { pageAllowed } from '@/lib/page-access';

/**
 * Shown INSTEAD of an admin page the operator holds no duty for (see `lib/page-access.ts`).
 *
 * Without it, opening such a page by URL showed "We couldn't load this. Please try again." and
 * a Try again button that could never work. One gate here, so no page has to remember. While
 * the session is still unknown the page renders as before; the API refuses its data anyway.
 * ASCII-only copy.
 */
export function PageAccessGate({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/admin';
  const { user } = useAuthUser();

  if (!user || pageAllowed(pathname, user)) return <>{children}</>;

  return (
    <section
      aria-labelledby="access-denied-heading"
      className="mx-auto mt-10 max-w-lg rounded-lg border border-border bg-background-surface p-6 text-center"
    >
      <h1 id="access-denied-heading" className="text-h3 font-bold tracking-tight text-text-primary">
        You do not have access to this page
      </h1>
      <p className="mt-2 text-[0.9375rem] text-text-muted">
        Your account does not have the duty this page needs. Ask a platform administrator if you
        need it.
      </p>
      <Link
        href="/admin"
        className="mt-6 inline-flex min-h-11 items-center justify-center rounded-md bg-action-primary px-5 text-ui font-semibold text-action-primary-foreground hover:bg-action-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        Go to the dashboard
      </Link>
    </section>
  );
}
