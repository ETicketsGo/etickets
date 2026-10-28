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

/**
 * What a band charges, in words: "Rs 10.00", "5% of the order (min Rs 20.00, max Rs 500.00)",
 * "3% of the order + Rs 5.00 per ticket", or "Rs 5.00 per ticket (min Rs 20.00)".
 *
 * A FLAT band charges once per order; FIXED_PER_TICKET charges for each paid ticket. The words
 * say "per ticket" only for the second, so the two cannot be confused in the table.
 *
 * One function for the table and the dialog preview, so the admin reads the same sentence in
 * both places and cannot be shown one charge while saving another.
 */
export function describeCharge(
  band: {
    feeType?: FeeBandType;
    feeMinor: number;
    feePercentBps?: number | null;
    minFeeMinor?: number | null;
    maxFeeMinor?: number | null;
  },
  currency: string,
): string {
  const pct = `${(band.feePercentBps ?? 0) / 100}% of the order`;
  const limits = [
    band.minFeeMinor != null ? `min ${money(band.minFeeMinor, currency)}` : null,
    band.maxFeeMinor != null ? `max ${money(band.maxFeeMinor, currency)}` : null,
  ].filter(Boolean);
  const withLimits = (text: string) => (limits.length ? `${text} (${limits.join(', ')})` : text);
  if (band.feeType === 'COMBINED') {
    return withLimits(`${pct} + ${money(band.feeMinor, currency)} per ticket`);
  }
  if (band.feeType === 'FIXED_PER_TICKET') {
    return withLimits(`${money(band.feeMinor, currency)} per ticket`);
  }
  if (band.feeType !== 'PERCENT') return money(band.feeMinor, currency);
  return withLimits(pct);
}

/** How a band charges. FLAT is once per order; FIXED_PER_TICKET is for each paid ticket. */
export type FeeBandType = 'FLAT' | 'PERCENT' | 'COMBINED' | 'FIXED_PER_TICKET';

/**
 * A whole-order fee held between an optional minimum and maximum, as the API does it: minimum
 * first, then maximum. Returns the fee and which limit, if any, changed it.
 */
export function limitFee(
  fee: number,
  minFeeMinor: number | null | undefined,
  maxFeeMinor: number | null | undefined,
): { fee: number; limit: 'MIN' | 'MAX' | null } {
  let out = fee;
  if (minFeeMinor != null) out = Math.max(out, minFeeMinor);
  if (maxFeeMinor != null) out = Math.min(out, maxFeeMinor);
  return { fee: out, limit: out > fee ? 'MIN' : out < fee ? 'MAX' : null };
}

/**
 * A worked example for a COMBINED band, from a one-ticket order inside the band: "One ticket of
 * Rs 1,000: Rs 30 + Rs 5 = Rs 35. Three tickets of Rs 1,000 each: Rs 105."
 *
 * The sample ticket is the band's lower bound, or Rs 1,000 (100,000 minor units) when the band
 * starts at zero and reaches that far. The three-ticket line is shown only while three such
 * tickets still fall inside the band, because a band is chosen by the order total.
 *
 * The same arithmetic as the API: the percentage rounded half up once on the order, plus the
 * fixed amount times the paid tickets. A preview only - the API prices every real order.
 */
export function combinedExample(
  band: {
    /** Omitted means COMBINED. FIXED_PER_TICKET has no percentage. */
    type?: 'COMBINED' | 'FIXED_PER_TICKET';
    percentBps: number | null;
    fixedPerTicketMinor: number;
    minMinor: number;
    maxMinor: number | null;
    /** Optional whole-order limits, applied after the parts are added up. */
    minFeeMinor?: number | null;
    maxFeeMinor?: number | null;
  },
  currency: string,
): string | null {
  const perTicketOnly = band.type === 'FIXED_PER_TICKET';
  if ((!perTicketOnly && band.percentBps === null) || !Number.isFinite(band.fixedPerTicketMinor)) {
    return null;
  }
  const bps = perTicketOnly ? 0 : band.percentBps!;
  const inBand = (amount: number) =>
    amount >= band.minMinor && (band.maxMinor === null || amount <= band.maxMinor);
  const sample = band.minMinor > 0 ? band.minMinor : inBand(100_000) ? 100_000 : band.maxMinor;
  if (!sample || sample <= 0) return null;
  const parts = (order: number, tickets: number) => ({
    pct: Math.round((order * bps) / 10_000),
    fixed: band.fixedPerTicketMinor * tickets,
  });
  const charged = (order: number, tickets: number) => {
    const p = parts(order, tickets);
    return limitFee(p.pct + p.fixed, band.minFeeMinor, band.maxFeeMinor);
  };
  const limitWords = (r: { fee: number; limit: 'MIN' | 'MAX' | null }) =>
    r.limit === 'MIN'
      ? `, raised to the minimum fee of ${money(r.fee, currency)}`
      : r.limit === 'MAX'
        ? `, held at the maximum fee of ${money(r.fee, currency)}`
        : '';
  const p1 = parts(sample, 1);
  const c1 = charged(sample, 1);
  const sum = perTicketOnly
    ? money(p1.fixed, currency)
    : `${money(p1.pct, currency)} + ${money(p1.fixed, currency)} = ${money(p1.pct + p1.fixed, currency)}`;
  const one = `One ticket of ${money(sample, currency)}: ${sum}${limitWords(c1)}.`;
  if (!inBand(sample * 3)) return one;
  const c3 = charged(sample * 3, 3);
  const three = c3.limit
    ? `${money(parts(sample * 3, 3).pct + parts(sample * 3, 3).fixed, currency)}${limitWords(c3)}`
    : money(c3.fee, currency);
  return `${one} Three tickets of ${money(sample, currency)} each: ${three}.`;
}

/** A short money range for the dialog preview, using the same formatter as the label. */
export function rangeText(minMinor: number, maxMinor: number | null, currency: string): string {
  return maxMinor === null
    ? `${money(minMinor, currency)} and above`
    : `${money(minMinor, currency)} - ${money(maxMinor, currency)}`;
}
