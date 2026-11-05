import type { HumanCheckSettings } from './human-check.settings';

/**
 * Asks Cloudflare whether a Turnstile token is genuine, and then checks what Cloudflare says.
 *
 * ── WHY `success: true` IS NOT ENOUGH ──────────────────────────────────────────────
 * Cloudflare answers "this token was solved, once, on a widget with your site key". It does NOT
 * answer "on our site" or "for this form". A token solved on another page that embeds our
 * public site key, or solved on the cheap support form and replayed at the phone-code route,
 * is `success: true`. So three more things are checked, each from the answer itself:
 *   - `hostname` is one of ours (TURNSTILE_ALLOWED_HOSTNAMES);
 *   - `action` is the one this route asked the widget for;
 *   - `challenge_ts` is recent (Cloudflare also expires tokens at 300 seconds; this keeps the
 *     bound ours even if that changes).
 *
 * ── TOKENS ARE SINGLE USE ──────────────────────────────────────────────────────────
 * Cloudflare refuses a second redemption with `timeout-or-duplicate`. That is a failed check,
 * never a reason to let the request through: a replayed token is exactly what an attacker who
 * paid a solving farm for one token would send a thousand times. The client must solve again.
 *
 * ── WHAT IS NEVER WRITTEN DOWN ─────────────────────────────────────────────────────
 * The token and the secret. Neither appears in a log line, a metric label or an error. The
 * outcome is a short fixed word, which is all an operator needs to tell "bots" from "outage".
 */

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export type VerifyOutcome =
  | { ok: true }
  | {
      ok: false;
      /** `failed`: the caller did not prove itself. `unavailable`: we could not find out. */
      kind: 'failed' | 'unavailable';
      reason:
        | 'invalid'
        | 'duplicate'
        | 'hostname'
        | 'action'
        | 'expired'
        | 'timeout'
        | 'network'
        | 'bad_response'
        | 'misconfigured';
    };

interface SiteverifyBody {
  success?: unknown;
  'error-codes'?: unknown;
  challenge_ts?: unknown;
  hostname?: unknown;
  action?: unknown;
}

/** Cloudflare error codes that mean OUR request was wrong, not the visitor's token. */
const OUR_FAULT = new Set([
  'missing-input-secret',
  'invalid-input-secret',
  'bad-request',
  'internal-error',
]);

/** Tokens are at most 2048 characters (Cloudflare's documented limit). Longer is not a token. */
const MAX_TOKEN_LENGTH = 2048;

/** A little room for clock difference between Cloudflare and this host. */
const CLOCK_SKEW_MS = 60_000;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export async function verifyTurnstileToken(input: {
  token: string;
  remoteIp: string | null;
  expectedAction: string;
  settings: Pick<
    HumanCheckSettings,
    'secretKey' | 'allowedHostnames' | 'verifyTimeoutMs' | 'maxTokenAgeSeconds'
  >;
  fetchImpl?: FetchLike;
  now?: () => number;
}): Promise<VerifyOutcome> {
  const { token, remoteIp, expectedAction, settings } = input;
  const fetchImpl = input.fetchImpl ?? ((url, init) => fetch(url, init));
  const now = input.now ?? Date.now;

  if (!settings.secretKey) return { ok: false, kind: 'unavailable', reason: 'misconfigured' };
  // Refused here so a megabyte "token" is never forwarded to Cloudflare on our behalf.
  if (!token || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, kind: 'failed', reason: 'invalid' };
  }

  const form = new URLSearchParams({ secret: settings.secretKey, response: token });
  if (remoteIp && remoteIp !== 'unknown') form.set('remoteip', remoteIp);

  let res: Response;
  try {
    res = await fetchImpl(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      // Bounded: a slow Cloudflare must cost a sign-in a few seconds, not hold it open.
      signal: AbortSignal.timeout(settings.verifyTimeoutMs),
      redirect: 'error',
    });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    return {
      ok: false,
      kind: 'unavailable',
      reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network',
    };
  }

  if (res.status >= 500) return { ok: false, kind: 'unavailable', reason: 'bad_response' };

  let body: SiteverifyBody;
  try {
    body = (await res.json()) as SiteverifyBody;
  } catch {
    return { ok: false, kind: 'unavailable', reason: 'bad_response' };
  }
  if (typeof body !== 'object' || body === null) {
    return { ok: false, kind: 'unavailable', reason: 'bad_response' };
  }

  const codes = Array.isArray(body['error-codes'])
    ? body['error-codes'].filter((c): c is string => typeof c === 'string')
    : [];

  if (body.success !== true) {
    if (codes.includes('timeout-or-duplicate')) {
      return { ok: false, kind: 'failed', reason: 'duplicate' };
    }
    if (codes.some((c) => OUR_FAULT.has(c))) {
      return { ok: false, kind: 'unavailable', reason: 'misconfigured' };
    }
    return { ok: false, kind: 'failed', reason: 'invalid' };
  }

  const hostname = typeof body.hostname === 'string' ? body.hostname.toLowerCase() : '';
  if (settings.allowedHostnames.length > 0 && !settings.allowedHostnames.includes(hostname)) {
    return { ok: false, kind: 'failed', reason: 'hostname' };
  }

  if (body.action !== expectedAction) return { ok: false, kind: 'failed', reason: 'action' };

  const solvedAt = typeof body.challenge_ts === 'string' ? Date.parse(body.challenge_ts) : NaN;
  const age = now() - solvedAt;
  if (!Number.isFinite(age) || age > settings.maxTokenAgeSeconds * 1000 || age < -CLOCK_SKEW_MS) {
    return { ok: false, kind: 'failed', reason: 'expired' };
  }

  return { ok: true };
}
