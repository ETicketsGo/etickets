'use client';

import { Link } from '@/i18n/navigation';
import { useShellAuth } from '@/lib/use-shell-auth';
import { useSignInHref } from '@/lib/use-sign-in-href';

/**
 * The footer's Sign in, carrying `?next=<this page>` like the header's - or, for somebody who is
 * already signed in, "My tickets" in its place.
 *
 * A signed-in customer was offered "Sign in" at the bottom of every platform page (N1), which
 * reads as having been signed out. The answer comes from the same hook as both headers
 * (`useShellAuth`), so the footer and the bar above it always agree.
 *
 * Its own component because the return address is the page being looked at, which only the
 * browser knows (the query string especially).
 */
export function FooterSignInLink({
  className,
  initialSignedIn = false,
  signInLabel,
  signedInLabel,
}: {
  className: string;
  initialSignedIn?: boolean;
  signInLabel: string;
  signedInLabel: string;
}) {
  const signInHref = useSignInHref();
  const { authed } = useShellAuth(initialSignedIn);
  if (authed) {
    return (
      <Link href="/account/tickets" className={className}>
        {signedInLabel}
      </Link>
    );
  }
  return (
    <Link href={signInHref} className={className}>
      {signInLabel}
    </Link>
  );
}
