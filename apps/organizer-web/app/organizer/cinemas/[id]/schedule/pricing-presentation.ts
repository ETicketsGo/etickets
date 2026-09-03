import type { ShowPricing } from '@eticketsgo/web-kit';
import { money } from '@eticketsgo/web-kit';

/**
 * Turning what an operator types into what the server is allowed to be told.
 *
 * Kept out of the component because money is the one thing on this screen that must not be
 * decided by a rendering accident. Every rule here — the rounding, the refusals, what counts
 * as changed — is testable without a browser.
 *
 * The client is NEVER the price authority. It converts rupees to paise and sends them; the
 * server re-reads the ticket type, applies the sold-lock, and writes. Nothing here is trusted
 * by anything.
 */

export type PriceDraft = Record<string, string>;

/** Paise → the string an operator edits. Two decimals always, so ₹250 reads as 250.00. */
export const minorToInput = (minor: number): string => (minor / 100).toFixed(2);

/**
 * Paise → display, via the one formatter.
 *
 * Indian grouping still, because `money()` picks en-IN for rupees itself. What changes is
 * that a whole-rupee price now reads ₹250 rather than ₹250.00, matching every other screen
 * — this copy printed two decimals always while the storefront copy printed none.
 */
export const formatMinor = (minor: number, currency = 'INR', fractionDigits?: number): string =>
  money(minor, currency, undefined, fractionDigits);

export interface ParsedPrice {
  ticketTypeId: string;
  priceMinor: number;
}

export type PriceProblem = { ticketTypeId: string; message: string };

/**
 * Read every editable row, refusing anything that is not money.
 *
 * `Number('')` is 0 and `Number('abc')` is NaN — both would otherwise become "free" if they
 * reached a `Math.round`. A blank field is a mistake, not a decision to give the seat away,
 * so it is refused rather than interpreted.
 *
 * Rounding is `Math.round`, not truncation: ₹250.005 typed into a field should become 25001
 * paise rather than silently losing the half-paise downward. Anything with more than two
 * decimals is refused outright, because a price the operator cannot see in full is a price
 * they did not agree to.
 */
export function parseDraft(
  pricing: ShowPricing,
  draft: PriceDraft,
): { prices: ParsedPrice[]; problems: PriceProblem[] } {
  const prices: ParsedPrice[] = [];
  const problems: PriceProblem[] = [];

  for (const cat of pricing.categories) {
    // A locked category is not editable, so it is submitted unchanged rather than omitted:
    // the endpoint takes the whole show, and leaving one out would read as "no opinion"
    // when the operator's opinion is "as it was".
    if (cat.locked) {
      prices.push({ ticketTypeId: cat.ticketTypeId, priceMinor: cat.priceMinor });
      continue;
    }

    const raw = (draft[cat.ticketTypeId] ?? minorToInput(cat.priceMinor)).trim();
    if (raw === '') {
      problems.push({ ticketTypeId: cat.ticketTypeId, message: `Enter a price for ${cat.name}.` });
      continue;
    }
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
      problems.push({
        ticketTypeId: cat.ticketTypeId,
        message: `${cat.name}: enter an amount in rupees, with at most two decimals.`,
      });
      continue;
    }
    const minor = Math.round(Number(raw) * 100);
    if (!Number.isSafeInteger(minor) || minor > 100_000_00) {
      problems.push({
        ticketTypeId: cat.ticketTypeId,
        message: `${cat.name}: that price is too high.`,
      });
      continue;
    }
    prices.push({ ticketTypeId: cat.ticketTypeId, priceMinor: minor });
  }

  return { prices, problems };
}

/** Rows whose price the operator actually moved. Used to decide whether Save does anything. */
export function changedRows(pricing: ShowPricing, prices: ParsedPrice[]): ParsedPrice[] {
  const current = new Map(pricing.categories.map((c) => [c.ticketTypeId, c.priceMinor]));
  return prices.filter((p) => current.get(p.ticketTypeId) !== p.priceMinor);
}

/**
 * Why a category cannot be edited, in the operator's terms.
 *
 * Null when it can. A disabled field with no explanation beside it reads as a bug, and the
 * operator's next move is a support ticket rather than a decision.
 */
export function lockReason(cat: ShowPricing['categories'][number]): string | null {
  if (!cat.locked) return null;
  return `${cat.soldCount} ${cat.soldCount === 1 ? 'seat has' : 'seats have'} sold at ${formatMinor(
    cat.priceMinor,
    cat.currency,
  )}, so this price is fixed for this show.`;
}

/**
 * Whether the whole show is beyond repricing, and why.
 *
 * Mirrors the server's refusals so the operator is told before they type, not after they
 * submit. The server still enforces both — this only saves a wasted attempt.
 */
export function showLockReason(pricing: ShowPricing, now: Date): string | null {
  if (pricing.status === 'CANCELLED') return 'This show is cancelled and cannot be repriced.';
  if (new Date(pricing.startsAt) <= now) {
    return 'This show has already started. Only future shows can be repriced.';
  }
  return null;
}

/**
 * A one-line note when tonight differs from the house price.
 *
 * Worth surfacing because the layout's price is what the NEXT show will be created from, so
 * a permanent change means editing the layout as well — and an operator who repriced one
 * show and expected all of them would otherwise find out from a customer.
 */
export function differsFromHouse(cat: ShowPricing['categories'][number]): string | null {
  if (cat.basePriceMinor === null || cat.basePriceMinor === cat.priceMinor) return null;
  return `House price ${formatMinor(cat.basePriceMinor, cat.currency)}`;
}
