/**
 * Stored codes, in the words a person would say.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * The shared `titleCase` only swaps underscores for spaces, so an enum that is already in capitals
 * stays in capitals: the console said "UNDER REVIEW", "CUSTOMER PAYS", "ORGANIZER OWNER" and
 * "PARTIALLY REFUNDED" in the middle of sentences, which reads as a code leaking through rather
 * than as an answer. Walked on QA on 2026-10-15. The money states have their own vocabulary
 * (`money-status.ts`); this covers everything else an admin page prints.
 *
 * Display only. Nothing here decides anything; the raw code stays what the page compares.
 */

/** "PARTIALLY_REFUNDED" -> "Partially refunded". A value that is not a code is left alone. */
export function plainWords(value: string | null | undefined): string {
  if (!value) return '';
  // Mixed case is somebody's own text (a name, "Sole proprietorship"): never rewrite it.
  if (!/^[A-Z0-9_ ]+$/.test(value)) return value;
  const words = value.toLowerCase().split(/[_ ]+/).filter(Boolean);
  if (words.length === 0) return value;
  return [words[0][0].toUpperCase() + words[0].slice(1), ...words.slice(1)].join(' ');
}

/** States whose plain reading is not just the code in lower case. */
const STATUS_WORDS: Record<string, string> = {
  UNDER_REVIEW: 'Under review',
  PARTIALLY_REFUNDED: 'Partly refunded',
  PENDING_PAYMENT: 'Awaiting payment',
  REQUIRES_PAYMENT: 'Not paid yet',
  SUCCEEDED: 'Paid',
  CHECKED_IN: 'Checked in',
  // A ticket that is ACTIVE is one that still gets somebody in.
  ACTIVE: 'Active',
  SOLD_OUT: 'Sold out',
  ENABLED: 'On',
  DISABLED: 'Off',
};

export function statusWords(status: string | null | undefined): string {
  if (!status) return '';
  return STATUS_WORDS[status] ?? plainWords(status);
}

const ROLE_WORDS: Record<string, string> = {
  CUSTOMER: 'Customer',
  ORGANIZER_OWNER: 'Organizer owner',
  ORGANIZER_MANAGER: 'Organizer manager',
  CHECKIN_STAFF: 'Check-in staff',
  ADMIN: 'Back-office staff',
  SUPER_ADMIN: 'Super admin',
};

export function roleWords(role: string): string {
  return ROLE_WORDS[role] ?? plainWords(role);
}

/** Who pays the booking fee, as the organizer chose it in the event wizard. */
const FEE_MODE_WORDS: Record<string, string> = {
  CUSTOMER_PAYS: 'The buyer pays the fees',
  ORGANIZER_PAYS: 'The organizer absorbs the fees',
  SHARED: 'Shared 50/50 between buyer and organizer',
};

export function feeModeWords(mode: string | null | undefined): string {
  if (!mode) return '';
  return FEE_MODE_WORDS[mode] ?? plainWords(mode);
}
