/**
 * Whether an organizer's payout bank account is in the BUSINESS's own name.
 *
 * One rule, used by the API before any payout is recorded paid and by the organizer console to
 * say why a payout is on hold. A company (or LLP, LLC, trust, society, partnership...) is paid
 * only into an account in its registered name; a sole proprietor or an individual is paid in
 * their own name and is not checked here.
 */
/** Legal forms whose money belongs to a business, not to a person. */
const PERSONAL_ENTITY_TYPES = new Set(
  ['sole proprietorship', 'sole proprietor', 'individual', 'hindu undivided family'].map((s) =>
    s.toLowerCase(),
  ),
);

/** Words that only describe the legal form; they do not identify the business. */
const FORM_WORDS = new Set([
  'private',
  'pvt',
  'public',
  'limited',
  'ltd',
  'llp',
  'llc',
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'co',
  'company',
  'the',
  'and',
  'of',
]);

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);

export type BankOwnership = 'MATCH' | 'MISMATCH' | 'NOT_CHECKED';

/**
 * Whether the bank account looks like the BUSINESS's account.
 *
 * Only asked of a business (a company, LLP, partnership, trust, society, LLC...): a sole
 * proprietor or an individual is paid in their own name. The account holder must carry every
 * identifying word of the registered legal name; "DeepTrics Software Solutions Pvt Ltd" is
 * matched by "DEEPTRICS SOFTWARE SOLUTIONS PRIVATE LIMITED", not by a person's name.
 *
 * A screen-level warning, never a decision: staff verify ownership against a bank document.
 * It exists so a personal account is never shown as ready for company payouts.
 */
export function bankOwnership(input: {
  holderName: string | null | undefined;
  legalName: string | null | undefined;
  legalEntityType: string | null | undefined;
}): BankOwnership {
  const { holderName, legalName, legalEntityType } = input;
  if (!holderName?.trim() || !legalName?.trim() || !legalEntityType?.trim()) return 'NOT_CHECKED';
  if (PERSONAL_ENTITY_TYPES.has(legalEntityType.trim().toLowerCase())) return 'NOT_CHECKED';
  const core = words(legalName).filter((w) => !FORM_WORDS.has(w));
  if (core.length === 0) return 'NOT_CHECKED';
  const holder = new Set(words(holderName));
  return core.every((w) => holder.has(w)) ? 'MATCH' : 'MISMATCH';
}
