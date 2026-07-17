// Lightweight "is the visitor signed in?" check for public/chrome components that must
// NOT pull in the full API client just to branch on auth. Mirrors web-kit's ACCESS_KEY
// ('etg_access'); the client remains the single source of truth for actual requests.
const ACCESS_KEY = 'etg_access';

export function isSignedIn(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage.getItem(ACCESS_KEY);
}
