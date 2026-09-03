/**
 * Who may read the Prometheus scrape endpoint.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * `/api/metrics` was `@Public()` with a comment saying it "MUST be network-restricted to
 * the metrics scraper only". On Railway there is no such restriction to apply — a service
 * either has a public domain or it does not — so the comment described a control nobody
 * had implemented, and the endpoint was readable by anyone who typed the URL. What it
 * publishes is not only process stats:
 *
 *     etg_gmv_minor_total          gross merchandise value, summed on booking confirm
 *     etg_bookings_confirmed_total
 *     etg_payments_succeeded_total / etg_payments_failed_total
 *     etg_refunds_completed_total
 *
 * On QA that is test data. In production it is live revenue, order volume and payment
 * failure rates, published to the internet.
 *
 * ── WHY THE RULE LIVES IN shared-types, AS A PURE FUNCTION ─────────────────────────
 * Two processes serve metrics: the API through a Nest guard, and the worker through a raw
 * `http.createServer` handler that has no Nest in it at all. Two implementations of one
 * access rule drift, and the half that drifts is the half nobody is looking at. This is
 * the rule; both call it.
 */

/** What the caller should do about a scrape request. */
export type MetricsAccess =
  /** Serve the metrics. */
  | 'allow'
  /** A token is configured and the request did not present it: 401. */
  | 'unauthorized'
  /** No token is configured in a deployed environment: 404, as if the route were absent. */
  | 'disabled';

export interface MetricsAccessInput {
  /** METRICS_TOKEN, if the deployment set one. */
  token: string | undefined;
  /** The raw Authorization header from the request, if any. */
  authorization: string | undefined;
  /** APP_ENV. NOT NODE_ENV — QA and UAT both run NODE_ENV=production. */
  appEnv: string | undefined;
}

/**
 * Environments that are a developer's own machine, where an unset token means "open" so
 * `npm run dev`, jest, vitest and Playwright all keep working exactly as before.
 *
 * Everything else — QA, UAT, STAGING, PRODUCTION — is reachable from the internet the
 * moment Railway gives the service a domain, so an unset token there means "off", never
 * "open". Fail closed on the side where being wrong is published.
 */
const DEVELOPER_ENVIRONMENTS = ['LOCAL', 'DEV'];

/**
 * Constant-time string comparison.
 *
 * `a === b` on a secret returns as soon as two bytes differ, and the time it took says how
 * long the matching prefix was. That is a slow leak over a network and a fast one to a
 * process on the same host. Comparing every byte regardless costs nothing here.
 *
 * Length is folded into the result rather than short-circuited on, so a wrong-length guess
 * does not return early either.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let i = 0; i < length; i += 1) {
    difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return difference === 0;
}

/** Pull the credential out of `Authorization: Bearer <token>`, case-insensitively. */
function bearer(authorization: string | undefined): string | undefined {
  const match = /^bearer\s+(.+)$/i.exec(authorization?.trim() ?? '');
  return match?.[1]?.trim() || undefined;
}

export function metricsAccess({ token, authorization, appEnv }: MetricsAccessInput): MetricsAccess {
  const configured = token?.trim();

  if (!configured) {
    /*
      No token. On a developer's machine that is the normal state and the endpoint stays
      open. Anywhere else it means somebody deployed without setting it, and the safe
      reading of that is "metrics are not available", not "metrics are available to
      everyone".
    */
    return DEVELOPER_ENVIRONMENTS.includes((appEnv ?? 'LOCAL').trim().toUpperCase())
      ? 'allow'
      : 'disabled';
  }

  const presented = bearer(authorization);
  if (!presented) return 'unauthorized';
  return constantTimeEquals(presented, configured) ? 'allow' : 'unauthorized';
}
