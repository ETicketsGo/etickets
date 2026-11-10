import { organizationIdentities, type OrganizationIdentityInput } from '@eticketsgo/web-kit';

/**
 * What the account menu in the organizer top bar says about the signed-in member.
 *
 * Pure, so the words are tested without a browser. The role is the member's role in the ACTIVE
 * organization (the one that decides what they may do on this screen), never a platform role.
 * ASCII only.
 */

/** A member's role in an organization, in words. */
const ORG_ROLE_LABEL: Record<string, string> = {
  ORGANIZER_OWNER: 'Owner',
  ORGANIZER_MANAGER: 'Manager',
  CHECKIN_STAFF: 'Check-in staff',
};

/** "ORGANIZER_OWNER" -> "Owner". Unknown or missing -> null, so the shell can fall back. */
export function orgRoleLabel(role: string | null | undefined): string | null {
  return (role && ORG_ROLE_LABEL[role]) || null;
}

export interface SwitchTarget {
  id: string;
  /** The organization's name. */
  name: string;
  /** What tells it apart from another organization with the same name, or null. */
  qualifier: string | null;
  /** The member's role there, in words, or null. */
  role: string | null;
}

/**
 * The OTHER organizations this member can switch to, in list order.
 *
 * Empty when there is nothing to switch to, which is how the menu knows to leave "Switch
 * organization" out. Names that would read the same are told apart the way the existing switcher
 * does (`organizationIdentities`); the qualifier is kept separate so it can sit on its own line.
 */
export function switchTargets(
  orgs: readonly OrganizationIdentityInput[],
  activeId: string | null | undefined,
): SwitchTarget[] {
  if (orgs.length <= 1) return [];
  const active = activeId && orgs.some((o) => o.id === activeId) ? activeId : orgs[0].id;
  const identities = organizationIdentities(orgs);
  return orgs
    .filter((o) => o.id !== active)
    .map((o) => {
      const identity = identities.find((i) => i.id === o.id);
      return {
        id: o.id,
        name: identity?.primary ?? o.name,
        // A role qualifier would repeat the role printed beside it.
        qualifier: identity?.secondarySource === 'role' ? null : (identity?.secondary ?? null),
        role: orgRoleLabel(o.myRole),
      };
    });
}
