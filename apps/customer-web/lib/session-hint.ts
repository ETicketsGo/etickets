import { cookies } from 'next/headers';

/**
 * Whether the server should draw the signed-in shell.
 *
 * ── WHY THE SERVER GUESSES AT ALL ──────────────────────────────────────────────────
 * Tokens live in `localStorage`, which a server render cannot see. So the shell and the home
 * page both started from `useState(false)` and corrected themselves in an effect: a signed-in
 * customer got the marketing landing and the signed-out header on the FIRST PAINT of every page
 * load, until hydration caught up. Reported as "I can see the regular landing page for just
 * micro seconds".
 *
 * ── IT IS A HINT, NOT A CREDENTIAL ─────────────────────────────────────────────────
 * The cookie carries `1` and nothing else - no token, no id, no email - and is written beside
 * the tokens by `tokenStore`. It decides which shell to DRAW and authorises nothing: every
 * request is still judged on the bearer token, and a forged cookie buys a different-looking
 * header and no access at all. Getting it wrong costs exactly what the old behaviour cost
 * every time: one corrective render.
 */
export const SESSION_HINT_COOKIE = 'etg_session';

export async function serverSessionHint(): Promise<boolean> {
  const store = await cookies();
  return store.get(SESSION_HINT_COOKIE)?.value === '1';
}
