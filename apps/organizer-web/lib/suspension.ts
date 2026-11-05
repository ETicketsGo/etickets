/**
 * Suspended organizations, as the organizer console sees them.
 *
 * Owner decision (2026-10-26): members of a SUSPENDED organization get no organizer console at
 * all. The API enforces it (every organizer API answers 403 ORGANIZATION_SUSPENDED); the
 * console's part is to say so plainly, offer the way to support, and show nothing else.
 *
 * `GET /organizations` still LISTS a suspended organization - its id, name and status only - so
 * the console can tell "suspended" apart from "no organization yet". These helpers are the one
 * place that splits the list, so the switcher, the masthead and the gate cannot disagree.
 */

export const SUSPENDED = 'SUSPENDED';

interface Listed {
  id: string;
  status?: string | null;
}

/** The organizations this member can actually work in. */
export function usableOrganizations<T extends Listed>(orgs: readonly T[] | undefined): T[] {
  return (orgs ?? []).filter((o) => o.status !== SUSPENDED);
}

/** The organizations that are suspended, for the suspended screen. */
export function suspendedOrganizations<T extends Listed>(orgs: readonly T[] | undefined): T[] {
  return (orgs ?? []).filter((o) => o.status === SUSPENDED);
}

/**
 * What the console shows: the ordinary console, the suspended screen, or neither yet.
 *
 * Only when EVERY organization this person belongs to is suspended does the whole console close.
 * Somebody who also works for another organization keeps that one; the suspended one is simply
 * not offered.
 */
export function consoleState(
  orgs: readonly Listed[] | undefined,
): 'loading' | 'console' | 'suspended' {
  if (!orgs) return 'loading';
  if (orgs.length > 0 && usableOrganizations(orgs).length === 0) return 'suspended';
  return 'console';
}

/** The storefront's contact page: the public way to reach support, signed in or not. */
export function supportContactHref(storefront: string | null): string | null {
  return storefront ? `${storefront.replace(/\/+$/, '')}/contact` : null;
}
