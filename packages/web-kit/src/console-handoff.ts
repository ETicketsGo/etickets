/**
 * The browser half of the storefront -> organizer console handoff (see the API's
 * `auth/handoff.service.ts`).
 *
 * ── WHY THE FRAGMENT ───────────────────────────────────────────────────────────────
 * The one-time code travels as `https://<console>/handoff#code=...`. A URL fragment is never sent
 * to any server - not in the request line, not in a Referer header - so it never reaches an
 * access log, a proxy or an analytics beacon. The console reads it, removes it from the address
 * bar AND the history entry with `history.replaceState` before doing anything else, and spends
 * it once. It is a 60-second, single-use code, never an access or refresh token: nothing in this
 * file ever puts a token in a URL.
 */

export const HANDOFF_PATH = '/handoff';

/** Where the storefront sends the browser with a freshly minted code. */
export function consoleHandoffUrl(consoleOrigin: string, code: string): string {
  return `${consoleOrigin.replace(/\/+$/, '')}${HANDOFF_PATH}#code=${encodeURIComponent(code)}`;
}

/** The code in a `#code=...` fragment, or null. Anything that is not a plausible code is null. */
export function readHandoffFragment(hash: string): string | null {
  const raw = new URLSearchParams(hash.replace(/^#/, '')).get('code');
  return raw && /^[A-Za-z0-9_-]{32,128}$/.test(raw) ? raw : null;
}

/** Three base64url segments, the first a JSON header: what a JWT looks like anywhere it appears. */
export const JWT_LIKE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
