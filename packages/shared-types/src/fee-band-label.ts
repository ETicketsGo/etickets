import { money } from './format';

/**
 * The name of a booking-fee band, written from its boundaries.
 *
 * ── WHY IT IS COMPUTED AND NOT STORED ──────────────────────────────────────────────
 * A band's label used to be typed by hand next to the two numbers it described. Edit the
 * numbers and the label stayed: "$0-$9.99" went on naming a band that now ran to $14.99, and
 * the console showed one range while the API charged another. Written from the boundaries every
 * time it is shown, the name cannot disagree with the band.
 *
 * The stored `FeeRule.label` column is left as it is - it is history, and nothing rewrites it.
 * It is simply no longer what anybody reads.
 *
 * Amounts go through THE money formatter, so a band reads exactly as a price does everywhere
 * else: "Tickets Rs 0 - Rs 499" is "Tickets ₹0 - ₹499" in INR (whole rupees print
 * without paise) and "Tickets $50.00 and above" in USD. The separator is an ASCII hyphen, per
 * the house rule on user-visible copy.
 *
 * `maxMinor` is inclusive, as the calculator reads it, and null means the band has no top.
 */
export function feeBandLabel(
  band: { minMinor: number; maxMinor: number | null },
  currency: string,
): string {
  const from = money(Math.max(0, band.minMinor), currency);
  if (band.maxMinor == null) return `Tickets ${from} and above`;
  return `Tickets ${from} - ${money(band.maxMinor, currency)}`;
}
