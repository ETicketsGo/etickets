import type { NextRequest } from 'next/server';
import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';
import { isIndexableDeployment, robotsTagFor } from './lib/indexability.mjs';

/**
 * Decides which language a request is served in, before anything renders.
 *
 * next-intl applies the order documented in `@eticketsgo/i18n`: an explicit choice we stored
 * in the cookie, then the URL, then `Accept-Language`, then the default. Geography is
 * deliberately absent — IP-based language switching is wrong about bilingual people, wrong
 * about travellers, and cannot be overridden by the person it is wrong about.
 */
const intl = createMiddleware(routing);

/*
  Read once: both are build arguments, inlined by Next, so they cannot change per request.
*/
const INDEXABLE = isIndexableDeployment({
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
  appEnv: process.env.NEXT_PUBLIC_APP_ENV,
});

/**
 * The language decision above, plus one header: `X-Robots-Tag`.
 *
 * QA and UAT send `noindex, nofollow` on every page (`next.config.mjs` also sends it on
 * everything else, static files included). Production sends nothing on www.eticketsgo.com,
 * and `noindex` when the same build is reached on another public host - the generated
 * `*.up.railway.app` name - so that copy never competes with the real one. The locale
 * response itself (redirect, rewrite or pass-through) is returned unchanged otherwise.
 */
export default function middleware(request: NextRequest) {
  const response = intl(request);
  const tag = robotsTagFor({
    indexable: INDEXABLE,
    host: request.headers.get('x-forwarded-host') ?? request.headers.get('host'),
  });
  if (tag) response.headers.set('X-Robots-Tag', tag);
  return response;
}

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

    `opengraph-image` and `twitter-image` are the sharing pictures (`app/opengraph-image.tsx`).
    They have no extension in their URL and no locale; sent through the locale rewrite they
    would be looked for under `/en/` and answer 404.

    Unsubscribe links carry a signed token `<payload>.<signature>`. The pattern above skips every
    path with a dot (static files), so those links never got their locale and answered 404. They
    are listed explicitly.
  */
  matcher: [
    '/((?!api|_next|_vercel|opengraph-image|twitter-image|.*\\..*).*)',
    '/unsubscribe/:token*',
    '/:locale/unsubscribe/:token*',
  ],
};
