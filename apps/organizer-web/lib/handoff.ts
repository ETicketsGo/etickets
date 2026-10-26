import { readHandoffFragment } from '@eticketsgo/web-kit';

/**
 * Take the one-time code out of the address bar, and out of history, before anything else runs.
 *
 * `history.replaceState` rewrites the CURRENT history entry, so neither the address bar, the
 * back button nor a bookmark of this page carries the code afterwards. It is also single-use and
 * dead in 60 seconds, but a credential is removed from where it can be seen, not merely expired.
 */
export function takeHandoffCode(
  location: { hash: string; pathname: string; search: string },
  history: { replaceState: (data: unknown, unused: string, url?: string) => void },
): string | null {
  const code = readHandoffFragment(location.hash);
  if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`);
  return code;
}

/** Where a session that came through the handoff goes: the same rule the sign-in form applies. */
export function afterHandoff(roles: readonly string[]): string {
  return roles.some((r) => r === 'ADMIN' || r === 'SUPER_ADMIN')
    ? `/back-office?next=${encodeURIComponent('/organizer')}`
    : '/organizer';
}
