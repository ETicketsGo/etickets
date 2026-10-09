import { isReservedEmail } from '@eticketsgo/shared-types';

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

/*
  ── THE ADMIN CONSOLE'S SIDE OF THIS ───────────────────────────────────────────────
  The customer apps never receive the placeholder: the API sends `email: null` for it. The admin
  console is different - its lists read stored rows (an account, a booking's buyer address made
  before checkout refused the placeholder, an audit actor), and changing what they return would
  mean changing every admin endpoint, some of them in finance code. So the console recognises the
  placeholder where it shows it, and the number comes from the placeholder itself, which is made
  from it: `phone+14695884580@...` is the account whose number is +14695884580.
*/

/** The E.164 number a phone-only placeholder address was made from, or null for a real one. */
export function phoneFromPlaceholderEmail(email: string | null | undefined): string | null {
  if (!isReservedEmail(email)) return null;
  const digits = /^phone\+(\d{4,15})@/i.exec((email ?? '').trim())?.[1];
  return digits ? `+${digits}` : null;
}

/** What an admin screen prints where an email address would go. */
export interface AdminContact {
  /** An email address, or a formatted phone number. Never a placeholder. */
  text: string;
  /** True when `text` is a phone number because the account signs in by phone. */
  phoneSignIn: boolean;
}

/**
 * The contact line for an admin screen: the email address, or - for a placeholder - the phone
 * number with a flag saying so, so the screen can label it "Phone sign-in" rather than let a
 * number pass for an address. Null when there is nothing honest to show.
 *
 * `phone` is the account's stored number where the response has it; it wins over the one in the
 * placeholder only because it is the column, not because they can differ.
 */
export function adminContact(
  email: string | null | undefined,
  phone?: string | null,
): AdminContact | null {
  const address = (email ?? '').trim();
  if (address && !isReservedEmail(address)) return { text: address, phoneSignIn: false };
  const number =
    formatPhoneForDisplay(phone) ?? formatPhoneForDisplay(phoneFromPlaceholderEmail(address));
  if (number) return { text: number, phoneSignIn: true };
  return null;
}
