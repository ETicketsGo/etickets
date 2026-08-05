/**
 * Pure client-side security helpers (framework-free, unit-tested). Shared so the same
 * redaction + URL guards run identically on web and mobile.
 */

const SECRET_KEY = /(authorization|token|password|otp|secret|cookie|refresh)/i;

/**
 * Recursively replace the values of secret-looking keys with `[Filtered]` — used to
 * scrub auth headers, tokens, OTPs and passwords before anything reaches an error
 * reporter (Sentry) or a log. Non-object values pass through unchanged.
 */
export function redactSecretKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redactSecretKeys) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[Filtered]' : redactSecretKeys(v);
    }
    return out as unknown as T;
  }
  return value;
}

/** True when a URL points at a local/loopback host (must never ship in a prod build). */
export function isLocalApiUrl(url: string): boolean {
  return /(?:^|\/\/)(?:localhost|127\.0\.0\.1|10\.0\.2\.2|0\.0\.0\.0)(?::|\/|$)/i.test(url);
}
