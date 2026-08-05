import { z } from 'zod';

/**
 * Deep-link parsing and validation.
 *
 * A deep link is untrusted input that arrives from outside the app — a browser, an
 * email, another app, a QR code someone printed. It can name any route with any
 * parameter. So this module does two things and refuses to do a third:
 *
 *   1. It maps ONLY a fixed allow-list of paths to in-app routes. An unknown path
 *      resolves to a fallback, never to whatever the URL said.
 *   2. It validates every parameter's shape before the route sees it.
 *   3. It never returns an external URL for the app to open. A link that could make
 *      the app fetch or navigate to an arbitrary host is a redirector, and building one
 *      into a ticketing app is how phishing gets a trusted wrapper.
 *
 * Authorization is NOT done here and cannot be. A link naming booking `bk_123` proves
 * nothing about who is holding the phone — the booking screen loads it through the
 * authenticated API, and the server decides whether this user may see it. An id in a
 * URL is a claim, not a permission.
 */

/** Ids the API issues are cuids: `c` followed by base36. Anything else is not ours. */
const idSchema = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[a-z0-9]+$/i, 'not an identifier');

/**
 * Slugs are lowercase alphanumerics and hyphens. Bounded and anchored, so a slug cannot
 * carry a traversal (`../`), a scheme, or a query string into a route parameter.
 */
const slugSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'not a slug');

export type DeepLinkTarget =
  | { kind: 'event'; slug: string }
  | { kind: 'movie'; slug: string }
  | { kind: 'session-seats'; sessionId: string; slug?: string }
  | { kind: 'booking'; bookingId: string }
  | { kind: 'tickets' }
  | { kind: 'search'; query?: string }
  | { kind: 'login'; email?: string }
  | { kind: 'register'; email?: string }
  | { kind: 'home' };

export type DeepLinkResolution =
  | { status: 'ok'; target: DeepLinkTarget; requiresAuth: boolean }
  | { status: 'unknown'; reason: string; target: DeepLinkTarget }
  | { status: 'rejected'; reason: string };

/** The fallback for anything unrecognised: Home, never the URL's own suggestion. */
const HOME: DeepLinkTarget = { kind: 'home' };

/**
 * Schemes this app will parse. `etickets://` is the custom scheme; https is the
 * universal/app-link form. Expo Go and dev clients also produce `exp://`.
 *
 * Anything else — javascript:, file:, intent:, content: — is rejected outright rather
 * than being allowed to reach the router.
 */
const ALLOWED_SCHEMES = new Set(['etickets:', 'https:', 'exp:', 'http:']);

/**
 * Resolve an incoming URL to an in-app destination.
 *
 * Returns a discriminated result rather than throwing, because the three outcomes need
 * different handling: navigate, navigate-to-fallback-and-say-nothing, or refuse.
 */
export function resolveDeepLink(url: string, webHost?: string | null): DeepLinkResolution {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { status: 'rejected', reason: 'Not a valid URL' };
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return { status: 'rejected', reason: `Unsupported scheme ${parsed.protocol}` };
  }

  /**
   * For an https link, the host must be OUR host. Without this check the app would
   * happily treat https://evil.example/booking/x as its own deep link and open a
   * booking screen from a page the user was phished onto. When no web host is
   * configured (dev builds), https links are not accepted at all rather than accepted
   * from anywhere.
   */
  if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
    if (!webHost) {
      return { status: 'rejected', reason: 'No universal-link host is configured' };
    }
    if (parsed.hostname.toLowerCase() !== webHost.toLowerCase()) {
      return { status: 'rejected', reason: `Unexpected host ${parsed.hostname}` };
    }
  }

  /**
   * Custom-scheme URLs put the first path element in `hostname`
   * ("etickets://booking/123" → hostname "booking"), while https URLs put everything in
   * `pathname`. Normalising both to a segment list keeps one set of rules for both.
   */
  const segments = [
    ...(parsed.protocol === 'etickets:' || parsed.protocol === 'exp:'
      ? [parsed.hostname].filter(Boolean)
      : []),
    ...parsed.pathname.split('/').filter(Boolean),
  ].map((s) => decodeURIComponent(s));

  if (segments.length === 0) return { status: 'ok', target: HOME, requiresAuth: false };

  const [head, ...rest] = segments;
  const params = parsed.searchParams;

  switch (head) {
    case 'event':
    case 'events': {
      const slug = slugSchema.safeParse(rest[0]);
      if (!slug.success) return unknown('Event link had no valid slug');
      return { status: 'ok', target: { kind: 'event', slug: slug.data }, requiresAuth: false };
    }

    case 'movie':
    case 'movies': {
      const slug = slugSchema.safeParse(rest[0]);
      if (!slug.success) return unknown('Movie link had no valid slug');
      return { status: 'ok', target: { kind: 'movie', slug: slug.data }, requiresAuth: false };
    }

    case 'session': {
      // /session/:id/seats
      const id = idSchema.safeParse(rest[0]);
      if (!id.success || rest[1] !== 'seats') return unknown('Session link was not a seats link');
      const slug = slugSchema.safeParse(params.get('slug') ?? '');
      return {
        status: 'ok',
        target: {
          kind: 'session-seats',
          sessionId: id.data,
          slug: slug.success ? slug.data : undefined,
        },
        requiresAuth: false,
      };
    }

    case 'booking':
    case 'bookings': {
      const id = idSchema.safeParse(rest[0]);
      if (!id.success) return unknown('Booking link had no valid id');
      // This is the payment-return target as well: the browser hands control back to
      // etickets://booking/<id>, and that screen re-reads the booking from the server
      // rather than trusting the return itself as proof of payment.
      return {
        status: 'ok',
        target: { kind: 'booking', bookingId: id.data },
        requiresAuth: true,
      };
    }

    case 'tickets':
      return { status: 'ok', target: { kind: 'tickets' }, requiresAuth: true };

    case 'search': {
      const raw = params.get('q');
      // Bounded, and stripped of control characters: it goes straight into a text input
      // and into a query string, and a newline or a NUL in either is only ever probing.
      const query = raw ? raw.replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 120) : undefined;
      return { status: 'ok', target: { kind: 'search', query }, requiresAuth: false };
    }

    case 'login':
    case 'register': {
      const email = z
        .string()
        .email()
        .max(200)
        .safeParse(params.get('email') ?? '');
      return {
        status: 'ok',
        target: {
          kind: head === 'login' ? 'login' : 'register',
          email: email.success ? email.data : undefined,
        },
        requiresAuth: false,
      };
    }

    case '':
    case 'home':
      return { status: 'ok', target: HOME, requiresAuth: false };

    default:
      return unknown(`No route for "${head}"`);
  }
}

function unknown(reason: string): DeepLinkResolution {
  // Unknown still lands the user somewhere sensible; it is not an error they caused.
  return { status: 'unknown', reason, target: HOME };
}

/**
 * The in-app path for a resolved target.
 *
 * Kept separate from resolution so the routes can be tested as pure data, and so a
 * caller cannot skip validation and hand the router a raw URL.
 */
export function targetToHref(target: DeepLinkTarget): {
  pathname: string;
  params?: Record<string, string>;
} {
  switch (target.kind) {
    case 'event':
      return { pathname: '/event/[slug]', params: { slug: target.slug } };
    case 'movie':
      return { pathname: '/movie/[slug]', params: { slug: target.slug } };
    case 'session-seats':
      return {
        pathname: '/session/[id]/seats',
        params: { id: target.sessionId, ...(target.slug ? { slug: target.slug } : {}) },
      };
    case 'booking':
      return { pathname: '/booking/[id]', params: { id: target.bookingId } };
    case 'tickets':
      return { pathname: '/(tabs)/tickets' };
    case 'search':
      return {
        pathname: '/(tabs)/search',
        ...(target.query ? { params: { q: target.query } } : {}),
      };
    case 'login':
      return {
        pathname: '/(auth)/login',
        ...(target.email ? { params: { email: target.email } } : {}),
      };
    case 'register':
      return {
        pathname: '/(auth)/register',
        ...(target.email ? { params: { email: target.email } } : {}),
      };
    case 'home':
    default:
      return { pathname: '/(tabs)' };
  }
}
