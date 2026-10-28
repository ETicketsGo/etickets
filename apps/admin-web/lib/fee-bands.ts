import { feeBandLabel, money } from '@eticketsgo/shared-types';
import type { FeeRule } from '@eticketsgo/web-kit';

/**
 * Booking-fee bands in the admin console: the words an operator reads, kept pure so they are
 * tested without a browser.
 *
 * ── THE NAME IS WRITTEN FROM THE BAND ─────────────────────────────────────────────
 * A band used to carry a label typed by hand. Change its boundaries and the label stayed, so
 * the table could say "$0 - $9.99" beside a band that ran to $14.99. The name is now written
 * from the boundaries every time (`feeBandLabel`, shared with the API), so it cannot disagree.
 */

/** The name a stored band is shown under. The API sends it; older responses are derived here. */
export function bandName(
  rule: Pick<FeeRule, 'minMinor' | 'maxMinor' | 'currency'> & {
    displayLabel?: string;
  },
): string {
  return rule.displayLabel ?? feeBandLabel(rule, rule.currency);
}

/**
 * The name a band being edited WILL have, from the boundaries as typed. Empty while the
 * boundaries are not numbers yet, so the form shows nothing rather than "NaN".
 */
export function draftBandName(
  draft: { minMinor: string; maxMinor: string },
  currency: string | null,
): string {
  if (!currency) return '';
  const min = draft.minMinor.trim() === '' ? 0 : Number(draft.minMinor);
  if (!Number.isFinite(min) || min < 0) return '';
  const rawMax = draft.maxMinor.trim();
  if (rawMax === '') return feeBandLabel({ minMinor: min, maxMinor: null }, currency);
  const max = Number(rawMax);
  if (!Number.isFinite(max)) return '';
  return feeBandLabel({ minMinor: min, maxMinor: max }, currency);
}

/** Where a band applies, in words. */
export function bandPlace(rule: Pick<FeeRule, 'country' | 'region'>): string {
  if (rule.region && rule.region !== '*') return `${rule.region}, ${rule.country}`;
  if (rule.country && rule.country !== '*') return rule.country;
  return 'Everywhere';
}

/** The sentence in the delete dialog: what goes, what stays, and what the API checks. */
export function deleteConfirmation(
  rule: Pick<FeeRule, 'minMinor' | 'maxMinor' | 'currency' | 'country' | 'region' | 'active'> & {
    displayLabel?: string;
  },
): { title: string; body: string } {
  const name = bandName(rule);
  const where = bandPlace(rule);
  const body = rule.active
    ? `Delete "${name}" for ${where}? New ${rule.currency} orders in this range will use the other bands. Bookings already made keep the fee they were charged. The delete is refused if it would leave orders with no band.`
    : `Delete "${name}" for ${where}? It is switched off, so it charges nobody now. Bookings already made keep the fee they were charged.`;
  return { title: `Delete fee band - ${name}`, body };
}

/** What a deleted band shows in the Active column. */
export function bandStatus(rule: Pick<FeeRule, 'active'> & { deletedAt?: string | null }): string {
  if (rule.deletedAt) return 'Deleted';
  return rule.active ? 'Yes' : 'No';
}

/** A short money range for the dialog preview, using the same formatter as the label. */
export function rangeText(minMinor: number, maxMinor: number | null, currency: string): string {
  return maxMinor === null
    ? `${money(minMinor, currency)} and above`
    : `${money(minMinor, currency)} - ${money(maxMinor, currency)}`;
}
