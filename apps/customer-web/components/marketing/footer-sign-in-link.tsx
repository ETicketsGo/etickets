'use client';

import { Link } from '@/i18n/navigation';
import { useSignInHref } from '@/lib/use-sign-in-href';

/**
 * The footer's Sign in, carrying `?next=<this page>` like the header's.
 *
 * Its own client component because the footer is a server component and the return address is
 * the page being looked at, which only the browser knows (the query string especially).
 */
export function FooterSignInLink({ className, children }: { className: string; children: string }) {
  return (
    <Link href={useSignInHref()} className={className}>
      {children}
    </Link>
  );
}
