'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { LogIn } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { isSignedIn } from '@/lib/auth-flag';
import { Card, ButtonLink } from '@/components/ui';

/**
 * Whether this visitor has a session, answered safely for a client component.
 *
 * -- WHY IT STARTS AS `null` --------------------------------------------------------------
 * `isSignedIn()` reads `localStorage`, which does not exist while the markup is produced on
 * the server. Reading it during the first render would make the server and the client
 * disagree and React would throw away the tree. So the first render answers "I do not know
 * yet", and the effect fills it in. Callers render a skeleton for `null` rather than guessing
 * either way - guessing signed-OUT flashes a sign-in prompt at somebody who is signed in.
 */
export function useSignedIn(): boolean | null {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  useEffect(() => setSignedIn(isSignedIn()), []);
  return signedIn;
}

/**
 * Was this failure "you are not signed in" rather than "something went wrong"?
 *
 * A 401 after the page believed it had a session means the session ended - expired, revoked,
 * or signed out in another tab. That is not an error the person can retry their way out of,
 * and telling them to try again sends them round a loop that cannot succeed.
 */
export function isAuthFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status?: number }).status === 401
  );
}

/**
 * What an account page shows somebody who is not signed in.
 *
 * -- THE DEFECT THIS REPLACES -------------------------------------------------------------
 * Every page under `/account` asked the API for private data on mount and rendered a red
 * "We couldn't load ..." box when the call came back 401. A signed-out visitor - anybody
 * following a link to their notification settings, say - was told the product was broken,
 * next to a "Try again" button that could only fail again. The page was working perfectly;
 * it simply had nobody to show it to.
 *
 * It also quietly cost the SMS programme: `/account/notification-settings` is where the
 * text-message consent lives, and it is linked from the public SMS page, so the one route a
 * person follows to turn messages ON was a red error unless they happened to be signed in
 * already.
 */
export function SignInRequired({ title, description }: { title: string; description: string }) {
  const pathname = usePathname();
  const next = encodeURIComponent(pathname || '/account');
  return (
    <Card className="mx-auto max-w-lg p-8 text-center">
      <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-tint-primary">
        <LogIn className="h-5 w-5 text-action-primary" aria-hidden />
      </div>
      <h2 className="mt-4 text-lg font-semibold text-text-primary">{title}</h2>
      <p className="mx-auto mt-2 max-w-sm text-[0.9375rem] leading-relaxed text-text-secondary">
        {description}
      </p>
      <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <ButtonLink href={`/login?next=${next}`}>Sign in</ButtonLink>
        <Link
          href={`/register?next=${next}`}
          className="rounded-sm text-[0.9375rem] font-medium text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          Create an account
        </Link>
      </div>
    </Card>
  );
}
