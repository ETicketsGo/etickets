/**
 * How an account is named on screen.
 *
 * Phone sign-in creates an account with no name and no email address. It used to be shown by
 * the placeholder address the database needs ("phone+14695884580@users.eticketsgo.internal")
 * and its initials ("PH"). The API no longer sends that placeholder; this decides what is shown
 * instead: the name if there is one, otherwise the person's own phone number, never an
 * internal identifier.
 */

/**
 * A phone number written the way people read it.
 *
 * North American numbers as "+1 469-588-4580", Indian as "+91 98765 43210". Anything else is
 * shown in E.164 as stored, which is unambiguous even if not local style.
 */
export function formatPhoneForDisplay(e164: string | null | undefined): string | null {
  const raw = (e164 ?? '').trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1 ${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 12 && digits.startsWith('91')) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  return raw.startsWith('+') ? raw : `+${digits}`;
}

interface AccountLike {
  fullName?: string | null;
  email?: string | null;
  phone?: string | null;
}

/** The line an account is called by: name, else email, else phone number, else null. */
export function accountName(user: AccountLike | null | undefined): string | null {
  const name = user?.fullName?.trim();
  if (name) return name;
  if (user?.email) return user.email;
  return formatPhoneForDisplay(user?.phone);
}

/** The contact line under the name: email, else phone number. Never the name repeated. */
export function accountContact(user: AccountLike | null | undefined): string | null {
  const name = accountName(user);
  const contact = user?.email || formatPhoneForDisplay(user?.phone);
  return contact && contact !== name ? contact : null;
}

/**
 * Initials only from something a person chose - a name, or a real email address. A phone-only
 * account has neither, and gets a generic avatar rather than letters made from digits.
 */
export function accountInitials(user: AccountLike | null | undefined): string | null {
  const source = user?.fullName?.trim() || (user?.email ?? '').split('@')[0] || '';
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
