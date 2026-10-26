import { api as wk, consoleHandoffUrl } from '@eticketsgo/web-kit';

/** Where the organizer console lives. The one source every storefront link to it reads. */
export const ORGANIZER_URL = (
  process.env.NEXT_PUBLIC_ORGANIZER_URL ?? 'http://localhost:3001'
).replace(/\/+$/, '');

/** The console's own sign-in, for when a handoff cannot be made. */
export const ORGANIZER_LOGIN_URL = `${ORGANIZER_URL}/login`;

/**
 * Open the organizer console as the account signed in HERE, without signing in again.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────
 * The console is another origin with its own session, so this link used to land on its sign-in
 * page - which offered only email and password, credentials a phone-registered organizer has
 * never had (production, 2026-10-25). Now the API mints a one-time, 60-second code for this
 * account (re-checking its organizer seat), and the browser carries it in the URL FRAGMENT to
 * `/handoff`, which removes it from history and spends it once for a console session.
 *
 * Never a token in the URL: the code is not a token, cannot call any API, and works once. If no
 * code can be made (no seat, a suspended organization, a network failure), the console's sign-in
 * page opens instead, which now offers phone sign-in as well as email.
 *
 * Returns the address it navigated to, so a test can assert what was put in the address bar.
 */
export async function openOrganizerConsole(
  navigate: (url: string) => void = (url) => window.location.assign(url),
): Promise<string> {
  let target = ORGANIZER_LOGIN_URL;
  try {
    const { code } = await wk.auth.createHandoff('organizer');
    target = consoleHandoffUrl(ORGANIZER_URL, code);
  } catch {
    // Fall back to signing in on the console: never a dead click.
  }
  navigate(target);
  return target;
}
