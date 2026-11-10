import { dutyLabel } from './duty-words';

/**
 * What the account menu in the admin top bar says about the signed-in operator.
 *
 * Read from the same source the console already gates its screens with: `roles` and
 * `adminPermissions` on `/auth/me` (see `capabilities.ts`). It is only words for the person's
 * own account - nothing here decides what they may open. ASCII only.
 *
 * A super admin holds every duty by role (`/auth/me` sends them all), so they are named as that,
 * not by a list of every duty. Anybody else is named by the duties they actually hold, in the
 * words the Staff & duties screen uses, so a duty in this menu is one they can find there.
 */
export interface AdminAccountIdentity {
  /** "Super admin", "Admin", or null for an account with no back-office role. */
  role: string | null;
  /** The duties held, in words. Empty for a super admin (they hold all of them). */
  duties: string[];
  /** One line for the menu: what this account may do here. */
  summary: string | null;
}

export function adminAccountIdentity(
  user: { roles?: readonly string[] | null; adminPermissions?: readonly string[] | null } | null,
): AdminAccountIdentity {
  const roles = user?.roles ?? [];
  if (roles.includes('SUPER_ADMIN')) {
    return { role: 'Super admin', duties: [], summary: 'Holds every duty' };
  }
  if (!roles.includes('ADMIN')) return { role: null, duties: [], summary: null };
  // De-duplicated and in a stable order, so the same account always reads the same.
  const duties = [...new Set(user?.adminPermissions ?? [])].map(dutyLabel).sort();
  return {
    role: 'Admin',
    duties,
    summary: duties.length === 0 ? 'No duties yet. Ask a super admin to give you one.' : null,
  };
}
