/**
 * The request path, as it is safe to write down.
 *
 * ── THE DEFECT THIS EXISTS FOR ─────────────────────────────────────────────────────
 * Two webhooks authenticate the caller with a secret in the URL, because their providers
 * register a callback URL in a dashboard and offer no custom header. For those routes the
 * path IS the credential — and the request logger wrote the path verbatim, so every callback
 * from Amazon put the live `SES_WEBHOOK_SECRET` into the service log, once per event.
 *
 * That reaches everyone with log access, plus every aggregator, backup and screenshot
 * downstream. It was found in QA by grepping the logs for the configured value and getting
 * four hits — one per SNS delivery.
 *
 * ── WHY THE CONSEQUENCE DIFFERS BY PROVIDER ────────────────────────────────────────
 * For SES the damage is bounded: the SNS signature is authoritative, so a leaked path secret
 * alone forges nothing. For MSG91 it is not bounded at all — MSG91 publishes no signature and
 * the path secret is the ONLY thing standing between a stranger and the ability to post
 * delivery reports, which suppress destinations. Anyone who could read a log could stop a
 * chosen person receiving their tickets.
 *
 * ── WHY A SHARED HELPER RATHER THAN A FIX AT EACH CALL SITE ────────────────────────
 * Three places derive a loggable path — the request interceptor, the exception filter's log
 * line, and the payload the exception filter sends to Sentry — and each had its own copy of
 * `(originalUrl || url).split('?')[0]`. Three copies is how one gets fixed and the others do
 * not, and the Sentry one leaves the estate entirely. One function, used by all three, is the
 * only version of this that stays true.
 */

/**
 * Route prefixes whose NEXT path segment is a credential.
 *
 * Deliberately a short, explicit list rather than a pattern like "redact anything that looks
 * like a token". A heuristic over every URL would quietly mangle booking references, event
 * slugs and ticket ids in exactly the logs somebody is reading to debug them — and would
 * still miss a secret that happened to look ordinary. These two routes are the ones where a
 * path segment is known to be a secret, and they are the only ones touched.
 *
 * Written without a leading prefix so the match is independent of `API_GLOBAL_PREFIX`: the
 * deployed path is `/api/notifications/webhooks/ses/…`, but the prefix is configuration and a
 * redaction that assumed `/api` would silently stop working the day somebody changed it.
 */
const CREDENTIAL_BEARING_ROUTES = [
  'notifications/webhooks/ses',
  'notifications/webhooks/msg91',
] as const;

/** What replaces the secret. Readable, obviously deliberate, and not mistakable for a value. */
export const REDACTED = '[REDACTED]';

const PATTERNS = CREDENTIAL_BEARING_ROUTES.map(
  (route) => new RegExp(`(^|/)(${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})/[^/?#]+`, 'gi'),
);

/**
 * Replace the credential segment of a known secret-bearing route.
 *
 * The route itself is preserved — `/api/notifications/webhooks/ses/[REDACTED]` still tells an
 * operator which provider called, whether it reached the right endpoint, and what it answered.
 * A log line that redacted the whole path would be safe and useless.
 *
 * Everything else is returned untouched.
 */
export function redactSecretSegments(path: string): string {
  let out = path;
  for (const pattern of PATTERNS) out = out.replace(pattern, `$1$2/${REDACTED}`);
  return out;
}

/**
 * The path to log for a request: query string dropped, credential segments redacted.
 *
 * The query string goes first and unconditionally. It is not part of any route this platform
 * defines, it is where tokens and email addresses turn up when a third party builds a link,
 * and no log line here has ever needed it.
 */
export function safeRequestPath(req: { originalUrl?: string; url?: string }): string {
  const raw = (req.originalUrl || req.url || '').split('?')[0];
  return redactSecretSegments(raw);
}
