// Lightweight "is the visitor signed in?" check for public/chrome components that must
// NOT pull in the full API client just to branch on auth. Mirrors web-kit's ACCESS_KEY
// ('etg_access'); the client remains the single source of truth for actual requests.
const ACCESS_KEY = 'etg_access';

export function isSignedIn(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage.getItem(ACCESS_KEY);
}

/**
 * Give the server the hint for somebody who was already signed in before it existed.
 *
 * The cookie is written by `tokenStore` when a session starts, so anybody holding a token from
 * BEFORE this shipped has none - and would keep seeing the marketing landing flash on every
 * load until they happened to sign out and in again. Writing it once, on the first render that
 * notices the mismatch, repairs those sessions without asking anybody to do anything.
 *
 * Only ever writes the TRUE direction. Clearing it is `tokenStore.clear()`'s job, and a stray
 * clear here would fight the session it is meant to describe.
 */
export function backfillSessionHint(): void {
  if (typeof document === 'undefined') return;
  if (!isSignedIn()) return;
  if (document.cookie.includes('etg_session=1')) return;
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `etg_session=1; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
}
