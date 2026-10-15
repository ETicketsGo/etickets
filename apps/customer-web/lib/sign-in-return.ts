import { safeNextPath } from '@eticketsgo/web-kit';

/**
 * Where somebody goes after signing in or creating an account on the storefront.
 *
 * ── WHY THE HOME PAGE, NOT "MY TICKETS" ───────────────────────────────────────────────────
 * Every way in ended at "My tickets" unless the link carried a `?next=`, and the header's Sign in
 * never carried one. So a buyer reading an event page who signed in to book it was taken away
 * from the event to an empty tickets list, and had to find the event again. The owner: "when user
 * sign in it is taking to tickets". The page they were on is where they go back to; with no such
 * page, the storefront's home, where a visit starts anyway. "My tickets" is still where they go
 * when they asked for it - its own link carries `?next=/account/tickets`.
 */
export const AFTER_SIGN_IN = '/';

/**
 * Pages that are no use straight after signing in: the sign-in and sign-up forms themselves.
 * Sending somebody back to one showed the form they had just filled in, as if it had failed.
 */
export const AUTH_PAGES = ['/login', '/register', '/forgot-password', '/reset-password'] as const;

/** The validated destination for a `?next=` value anyone can write (a path on this site only). */
export function afterSignIn(next: string | null | undefined): string {
  return safeNextPath(next, AFTER_SIGN_IN, AUTH_PAGES);
}

/**
 * The Sign in link for somebody looking at `here` (a path on this site, query included).
 *
 * The home page and the sign-in pages need no return address: home is the default anyway, and
 * returning to a sign-in form is the dead end `afterSignIn` refuses.
 */
export function signInHref(here: string | null | undefined): string {
  const next = here ? afterSignIn(here) : AFTER_SIGN_IN;
  return next === AFTER_SIGN_IN ? '/login' : `/login?next=${encodeURIComponent(next)}`;
}

/**
 * The admin console's address, seen from the storefront.
 *
 * A back-office account cannot sign in here (the API asks it for a second factor this page does
 * not take), and the refusal used to be a sentence with no way onward: the owner signed in as
 * the administrator and was left on the storefront's form. The console's address follows the
 * way the deployments are named, so no new build variable is needed:
 *
 *   qa.eticketsgo.com      -> admin-qa.eticketsgo.com
 *   uat.eticketsgo.com     -> admin-uat.eticketsgo.com
 *   eticketsgo.com (www.)  -> admin.eticketsgo.com
 *   localhost (any port)   -> localhost:3002
 *
 * `NEXT_PUBLIC_ADMIN_URL`, when a deployment sets it, wins. Any other host gets null and the
 * caller shows the sentence without a link rather than guess.
 */
export function adminConsoleOrigin(
  location: { protocol: string; hostname: string } | undefined,
  configured: string | undefined = process.env.NEXT_PUBLIC_ADMIN_URL,
): string | null {
  if (configured && configured.trim()) return configured.trim().replace(/\/+$/, '');
  if (!location) return null;
  const { protocol, hostname } = location;
  if (hostname === 'localhost' || hostname === '127.0.0.1') return `${protocol}//${hostname}:3002`;
  const host = hostname.replace(/^www\./, '');
  if (host === 'eticketsgo.com') return `${protocol}//admin.eticketsgo.com`;
  const env = /^(qa|uat)\.eticketsgo\.com$/.exec(host);
  if (env) return `${protocol}//admin-${env[1]}.eticketsgo.com`;
  return null;
}
