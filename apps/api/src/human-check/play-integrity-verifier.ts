import { createHash } from 'node:crypto';
import type { HumanCheckSettings } from './human-check.settings';
import { normaliseDigest } from './play-integrity-digest';

export { normaliseDigest };

/**
 * Asks Google Play whether an integrity token came from our genuine app on a genuine device,
 * and then checks what Google says. The Android app's answer to the human check: Turnstile is
 * a web widget, and a native app has no page to draw it on.
 *
 * ── WHAT THE TOKEN IS BOUND TO ─────────────────────────────────────────────────────
 * The app asks Play for a token over a `requestHash` it computes from the route's action and a
 * random nonce it sends alongside (`playIntegrityRequestHash`). Google signs that hash into the
 * verdict, so a token minted for the cheap support form cannot be replayed at the phone-code
 * route, and the nonce is claimed once on our side (`HumanCheckRisk.claimOnce`), so a token
 * cannot be sent twice either. Play itself does not refuse a second decode of the same token.
 *
 * ── WHY "GOOGLE DECODED IT" IS NOT ENOUGH ──────────────────────────────────────────
 * Google decodes any token for our package, including one from a modified copy of the app on
 * a rooted emulator: the verdict says so instead of failing. So each field is checked:
 *   - `requestDetails.requestPackageName` and `appIntegrity.packageName` are the package we
 *     decoded for (one of PLAY_INTEGRITY_PACKAGE_NAMES);
 *   - `requestDetails.requestHash` is the hash of this action and this nonce;
 *   - `requestDetails.timestampMillis` is recent;
 *   - `appIntegrity.appRecognitionVerdict` is PLAY_RECOGNIZED (the binary Play distributed).
 *     UNRECOGNIZED_VERSION is accepted only where PLAY_INTEGRITY_ALLOW_UNRECOGNIZED_APP is on,
 *     for sideloaded QA builds, and never in production (refused at boot);
 *   - when PLAY_INTEGRITY_CERT_SHA256 is set, the signing certificate is one of those;
 *   - `deviceIntegrity.deviceRecognitionVerdict` includes MEETS_DEVICE_INTEGRITY (a genuine,
 *     certified Android device; MEETS_STRONG_INTEGRITY implies it).
 *
 * ── WHAT IS NEVER WRITTEN DOWN ─────────────────────────────────────────────────────
 * The token, the service-account key and the access token. The outcome is a short fixed word.
 */

export const PLAY_INTEGRITY_SCOPE = 'https://www.googleapis.com/auth/playintegrity';

export const decodeUrlFor = (packageName: string) =>
  `https://playintegrity.googleapis.com/v1/${encodeURIComponent(packageName)}:decodeIntegrityToken`;

/**
 * The hash the app passes to `requestIntegrityCheckAsync`, and the one the verdict must carry.
 * Hex SHA-256, 64 characters (Play allows up to 500). The app computes the same string: see
 * apps/customer-mobile/src/services/human-check.ts.
 */
export function playIntegrityRequestHash(action: string, nonce: string): string {
  return createHash('sha256').update(`eticketsgo:${action}:${nonce}`).digest('hex');
}

/** A nonce is the app's random, 16 to 128 URL-safe characters. Anything else is not one. */
export const PLAY_INTEGRITY_NONCE = /^[A-Za-z0-9_-]{16,128}$/;

/** Play's tokens are long (a few KB), but not unbounded: never forward a megabyte to Google. */
const MAX_TOKEN_LENGTH = 16_384;

const CLOCK_SKEW_MS = 60_000;

export type PlayIntegrityOutcome =
  | { ok: true }
  | {
      ok: false;
      kind: 'failed' | 'unavailable';
      reason:
        | 'invalid'
        | 'package'
        | 'binding'
        | 'expired'
        | 'app'
        | 'certificate'
        | 'device'
        | 'timeout'
        | 'network'
        | 'bad_response'
        | 'misconfigured';
    };

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Returns an OAuth access token for the service account. Injected so tests never sign a JWT. */
export type AccessTokenProvider = () => Promise<string>;

interface Verdict {
  requestDetails?: {
    requestPackageName?: unknown;
    requestHash?: unknown;
    timestampMillis?: unknown;
  };
  appIntegrity?: {
    appRecognitionVerdict?: unknown;
    packageName?: unknown;
    certificateSha256Digest?: unknown;
  };
  deviceIntegrity?: { deviceRecognitionVerdict?: unknown };
}

type Settings = Pick<
  HumanCheckSettings,
  'playIntegrity' | 'verifyTimeoutMs' | 'maxTokenAgeSeconds'
>;

export async function verifyPlayIntegrityToken(input: {
  token: string;
  packageName: string;
  expectedRequestHash: string;
  settings: Settings;
  accessToken: AccessTokenProvider;
  fetchImpl?: FetchLike;
  now?: () => number;
}): Promise<PlayIntegrityOutcome> {
  const { token, packageName, expectedRequestHash, settings } = input;
  const pi = settings.playIntegrity;
  const fetchImpl = input.fetchImpl ?? ((url, init) => fetch(url, init));
  const now = input.now ?? Date.now;

  if (!pi) return { ok: false, kind: 'unavailable', reason: 'misconfigured' };
  if (!token || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, kind: 'failed', reason: 'invalid' };
  }
  // Checked before Google is asked: a package that is not ours is never decoded on our quota.
  if (!pi.packageNames.includes(packageName)) {
    return { ok: false, kind: 'failed', reason: 'package' };
  }

  let bearer: string;
  try {
    bearer = await input.accessToken();
  } catch {
    // A key Google refuses, or Google's token endpoint unreachable: either way not the caller.
    return { ok: false, kind: 'unavailable', reason: 'misconfigured' };
  }

  let res: Response;
  try {
    res = await fetchImpl(decodeUrlFor(packageName), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ integrity_token: token }),
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

  // 400: the token is not a Play token for this package. That is the caller's doing.
  if (res.status === 400) return { ok: false, kind: 'failed', reason: 'invalid' };
  // 401/403: our key or project is wrong (or the API is not enabled). 404: wrong package link.
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    return { ok: false, kind: 'unavailable', reason: 'misconfigured' };
  }
  if (!res.ok) return { ok: false, kind: 'unavailable', reason: 'bad_response' };

  let verdict: Verdict;
  try {
    const body = (await res.json()) as { tokenPayloadExternal?: Verdict } | null;
    if (!body || typeof body.tokenPayloadExternal !== 'object' || !body.tokenPayloadExternal) {
      return { ok: false, kind: 'unavailable', reason: 'bad_response' };
    }
    verdict = body.tokenPayloadExternal;
  } catch {
    return { ok: false, kind: 'unavailable', reason: 'bad_response' };
  }

  const request = verdict.requestDetails ?? {};
  const app = verdict.appIntegrity ?? {};
  const device = verdict.deviceIntegrity ?? {};

  if (request.requestPackageName !== packageName) {
    return { ok: false, kind: 'failed', reason: 'package' };
  }
  if (request.requestHash !== expectedRequestHash) {
    return { ok: false, kind: 'failed', reason: 'binding' };
  }

  const issuedAt = Number(request.timestampMillis);
  const age = now() - issuedAt;
  if (!Number.isFinite(age) || age > settings.maxTokenAgeSeconds * 1000 || age < -CLOCK_SKEW_MS) {
    return { ok: false, kind: 'failed', reason: 'expired' };
  }

  const recognition = app.appRecognitionVerdict;
  const recognised =
    recognition === 'PLAY_RECOGNIZED' ||
    (recognition === 'UNRECOGNIZED_VERSION' && pi.allowUnrecognizedApp);
  if (!recognised) return { ok: false, kind: 'failed', reason: 'app' };
  // Absent only when the app is UNEVALUATED, which is already refused above.
  if (app.packageName !== packageName) return { ok: false, kind: 'failed', reason: 'package' };

  if (pi.certificateDigests.length > 0) {
    const digests = Array.isArray(app.certificateSha256Digest)
      ? app.certificateSha256Digest.filter((d): d is string => typeof d === 'string')
      : [];
    if (!digests.some((d) => pi.certificateDigests.includes(normaliseDigest(d)))) {
      return { ok: false, kind: 'failed', reason: 'certificate' };
    }
  }

  const labels = Array.isArray(device.deviceRecognitionVerdict)
    ? device.deviceRecognitionVerdict
    : [];
  if (!labels.includes('MEETS_DEVICE_INTEGRITY') && !labels.includes('MEETS_STRONG_INTEGRITY')) {
    return { ok: false, kind: 'failed', reason: 'device' };
  }

  return { ok: true };
}
