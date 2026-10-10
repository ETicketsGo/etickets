import { useAuthUser } from '@eticketsgo/web-kit';

/**
 * Whether the signed-in operator holds a back-office capability.
 *
 * ── WHY A PAGE ASKS, NOT ONLY THE MENU ─────────────────────────────────────────────
 * The menu decides who can open a page (`admin-nav.ts`). A configuration page is opened with
 * the READ capability (`PLATFORM_CONFIG_READ`), but its buttons call routes that need the WRITE
 * one (`PLATFORM_CONFIG`). Showing "Edit" to somebody who can only read means every click ends
 * in "you may not do that" - so the page hides what the API would refuse.
 *
 * Like the menu, this is not the authorization; the API refuses the request either way. A super
 * admin is sent every capability by `/auth/me`, so nothing is special-cased here. Unknown
 * (still loading, or signed out) holds nothing, so a write control never flashes in first.
 */
export function holds(
  user: { adminPermissions?: readonly string[] } | null | undefined,
  capability: string,
): boolean {
  return (user?.adminPermissions ?? []).includes(capability);
}

/** `holds` for the signed-in operator. */
export function useHolds(capability: string): boolean {
  const { user } = useAuthUser();
  return holds(user, capability);
}

/**
 * What the signed-in operator may do on a platform-configuration page.
 *
 * `mayRead` gates the page's own data request. Somebody who reaches the page by URL without the
 * read capability would otherwise get a refused request rendered as an empty list - "No tax rules
 * configured" - which is a false statement about the platform, not a permissions message.
 */
export function useConfigAccess(): { known: boolean; mayRead: boolean; mayEdit: boolean } {
  const { user, isLoading } = useAuthUser();
  return {
    known: !isLoading && !!user,
    mayRead: holds(user, 'PLATFORM_CONFIG_READ'),
    mayEdit: holds(user, 'PLATFORM_CONFIG'),
  };
}

/** Shown instead of a configuration page to somebody who may not read it. ASCII only. */
export const NO_READ_ACCESS =
  'You do not have access to this page. Seeing platform settings needs the Platform configuration (read) duty.';

/** The line a read-only operator sees where the write controls would be. ASCII only. */
export const READ_ONLY_NOTE =
  'You can see these settings but not change them. Changing them needs the Platform configuration duty.';

/**
 * A capability as the Staff & duties screen names it: OPS_EXECUTE reads "Ops execute". The same
 * rule as that screen, so the note below names a duty an operator can find there and ask for.
 */
export function dutyName(capability: string): string {
  return capability.charAt(0) + capability.slice(1).toLowerCase().replace(/_/g, ' ');
}

/**
 * The line shown where an action's controls would be, to somebody who can read the page but not
 * act on it. Never a dead button: a disabled control with no reason reads as a fault, and an
 * enabled one ends in "you may not do that". ASCII only.
 *
 * `action` finishes "You can see this but cannot ...", e.g. "retry failed jobs".
 */
export function missingDutyNote(action: string, capability: string): string {
  return `You can see this but cannot ${action}. That needs the ${dutyName(capability)} duty.`;
}
