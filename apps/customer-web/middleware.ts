import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

/**
 * Decides which language a request is served in, before anything renders.
 *
 * next-intl applies the order documented in `@eticketsgo/i18n`: an explicit choice we stored
 * in the cookie, then the URL, then `Accept-Language`, then the default. Geography is
 * deliberately absent — IP-based language switching is wrong about bilingual people, wrong
 * about travellers, and cannot be overridden by the person it is wrong about.
 */
export default createMiddleware(routing);

export const config = {
  /*
    Everything except the things that are not pages.

    `api` is this app's own route handlers and `_next` is the build output. The last clause
    excludes anything with a file extension — images, the service worker, the manifest — and
    it is the one to be careful with: a manifest served through a locale rewrite is a
    manifest that fails to parse.

    The double backslash is load-bearing. `\\.` in this string literal is the two characters
    `\.`, which is a literal dot in the regex. Written as a single `\.` it becomes a bare `.`
    — "any character" — and the exclusion then swallows every path with more than one
    character in it, so the middleware runs on `/` alone and every other route 404s while
    looking exactly like a routing problem.
  */
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
