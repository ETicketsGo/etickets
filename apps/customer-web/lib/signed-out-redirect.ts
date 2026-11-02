/**
 * Account pages that send a signed-out visitor to sign in, answered BEFORE anything renders.
 *
 * ── WHY THIS IS IN THE MIDDLEWARE (2026-11, refresh flicker) ───────────────────────
 * These pages decided in a client effect: the server drew the page ("Your account" and its
 * empty panels), hydration ran, the effect saw no token, and only then did the browser go to
 * sign in. A signed-out visitor who opened or refreshed /account watched the account page for
 * about half a second and then the sign-in page replace it.
 *
 * The decision is made here from the session-hint cookie (`etg_session`, see
 * `lib/session-hint.ts`), the same hint that picks the header the server draws. It is a hint,
 * not a credential: it only chooses where to SEND somebody, and the pages keep their own
 * client check, so a stale hint costs at most what it cost before - the page, then sign in.
 *
 * Only the pages that already redirect are listed, with the `next` each one already used.
 * Other account pages show a sign-in prompt in place, and are left to do so.
 */
const SIGN_IN_FIRST: Record<string, string> = {
  '/account': '/account',
  '/account/become-organizer': '/account/become-organizer',
  '/account/organizer-console': '/account/organizer-console',
};

/**
 * Where to send this request instead, or null to serve it.
 *
 * `locales` are the non-default locale prefixes (`/fr-CA/account`); the default locale has no
 * prefix in a URL (`localePrefix: 'as-needed'`) but may arrive with one before the locale
 * middleware strips it, so both shapes are recognised and the prefix is kept.
 */
export function signedOutRedirect(
  pathname: string,
  signedInHint: boolean,
  locales: readonly string[],
): string | null {
  if (signedInHint) return null;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const prefix = locales.find((l) => path === `/${l}` || path.startsWith(`/${l}/`));
  const rest = prefix ? path.slice(prefix.length + 1) || '/' : path;
  const next = SIGN_IN_FIRST[rest];
  if (!next) return null;
  return `${prefix ? `/${prefix}` : ''}/login?next=${encodeURIComponent(next)}`;
}
