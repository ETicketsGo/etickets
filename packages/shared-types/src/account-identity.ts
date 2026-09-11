/**
 * Addresses this platform issues to itself.
 *
 * Phone sign-in creates an account with no email, but `User.email` is required and unique, so
 * a placeholder is derived from the number in a domain this platform owns. That placeholder
 * is never shown and never written to.
 *
 * ── WHY THE DOMAIN MUST BE RESERVED ────────────────────────────────────────────────
 * Nothing stopped a person REGISTERING an address in that domain. One that matched a phone
 * number's placeholder would make that number unable to ever sign in: creating its account
 * would collide with the row somebody else had already made. So registration and invitations
 * refuse the domain before any account exists.
 */

export const PHONE_ONLY_EMAIL_DOMAIN = 'users.eticketsgo.internal';

/** The placeholder address for a phone-only account. Existing rows use exactly this shape. */
export function phoneOnlyEmail(e164: string): string {
  return `phone+${e164.replace(/\D/g, '')}@${PHONE_ONLY_EMAIL_DOMAIN}`;
}

/** True for an address in a domain the platform keeps for itself, including subdomains. */
export function isReservedEmail(email: string | null | undefined): boolean {
  const domain = (email ?? '').trim().toLowerCase().split('@')[1] ?? '';
  return domain === PHONE_ONLY_EMAIL_DOMAIN || domain.endsWith(`.${PHONE_ONLY_EMAIL_DOMAIN}`);
}
