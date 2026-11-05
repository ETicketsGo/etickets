/**
 * Duplicate-detection keys for an acquisition lead.
 *
 * Two agents chasing the same organizer is the failure a sales desk notices first: the
 * organizer gets two cold calls a day apart, from people who each think it is their lead.
 * Exact text never catches it - "Sunrise Events Pvt. Ltd." and "sunrise events" are one
 * company - so each lead stores four normalized keys, and a new lead is checked against
 * every existing one on any of them.
 *
 * Pure functions, so the rules are tested on their own and the same keys come out of a typed
 * form, an edit and a spreadsheet import.
 */

/** Words that say what KIND of company it is, not which one. */
const LEGAL_SUFFIXES = new Set([
  'the',
  'pvt',
  'private',
  'ltd',
  'limited',
  'llc',
  'llp',
  'inc',
  'incorporated',
  'co',
  'company',
  'corp',
  'corporation',
  'plc',
  'opc',
]);

/** Mailboxes anybody can have: their domain says nothing about which organization it is. */
const FREE_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.in',
  'yahoo.in',
  'ymail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'rediffmail.com',
  'zohomail.com',
  'zohomail.in',
  'gmx.com',
  'mail.com',
]);

export function nameKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const words = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !LEGAL_SUFFIXES.has(w));
  const key = words.join(' ').trim();
  return key.length >= 2 ? key : null;
}

/** "https://www.Example.com/about" -> "example.com". */
export function websiteDomain(website: string | null | undefined): string | null {
  if (!website) return null;
  let host = website.trim().toLowerCase();
  host = host.replace(/^[a-z]+:\/\//, '');
  host = host.split(/[/?#]/)[0].split('@').pop() ?? '';
  host = host
    .replace(/:\d+$/, '')
    .replace(/^www\d*\./, '')
    .replace(/\.$/, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : null;
}

export function emailKey(email: string | null | undefined): string | null {
  if (!email) return null;
  const e = email.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : null;
}

/** The organization's own domain from an email, or null for a free mailbox. */
export function emailDomain(email: string | null | undefined): string | null {
  const e = emailKey(email);
  if (!e) return null;
  const domain = e.split('@')[1];
  return FREE_MAIL_DOMAINS.has(domain) ? null : websiteDomain(domain);
}

/**
 * Digits with the country code, so "+91 98765 43210", "098765 43210" and "9876543210" (typed
 * by somebody in the India team) are one number.
 */
export function phoneKey(phone: string | null | undefined, country?: string | null): string | null {
  if (!phone) return null;
  const hadPlus = phone.trim().startsWith('+');
  let digits = phone.replace(/\D/g, '');
  if (!hadPlus) {
    if (digits.startsWith('00')) digits = digits.slice(2);
    else if (country === 'IN' && digits.length === 11 && digits.startsWith('0'))
      digits = `91${digits.slice(1)}`;
    else if (country === 'IN' && digits.length === 10) digits = `91${digits}`;
    else if (country === 'US' && digits.length === 10) digits = `1${digits}`;
  }
  return digits.length >= 8 ? digits : null;
}

export interface LeadKeys {
  nameKey: string | null;
  domainKey: string | null;
  emailKey: string | null;
  phoneKey: string | null;
}

export function leadKeys(input: {
  organizationName?: string | null;
  website?: string | null;
  email?: string | null;
  phone?: string | null;
  country?: string | null;
}): LeadKeys {
  return {
    nameKey: nameKey(input.organizationName),
    domainKey: websiteDomain(input.website) ?? emailDomain(input.email),
    emailKey: emailKey(input.email),
    phoneKey: phoneKey(input.phone, input.country),
  };
}

export type DuplicateField = 'name' | 'domain' | 'email' | 'phone';

/** Which keys two leads share. */
export function sharedKeys(a: LeadKeys, b: LeadKeys): DuplicateField[] {
  const out: DuplicateField[] = [];
  if (a.nameKey && a.nameKey === b.nameKey) out.push('name');
  if (a.domainKey && a.domainKey === b.domainKey) out.push('domain');
  if (a.emailKey && a.emailKey === b.emailKey) out.push('email');
  if (a.phoneKey && a.phoneKey === b.phoneKey) out.push('phone');
  return out;
}
