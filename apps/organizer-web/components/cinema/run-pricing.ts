import { money, type SeatClassMapping, type SeatMap } from '@eticketsgo/web-kit';

/**
 * Prices for a run of shows, decided before the run is created.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────
 * Walking QA (2026-10-15): "Schedule a run" and the cinema's "Create shows" had no price
 * fields. Every show was created at the layout's house prices without a word, and the only way
 * to charge anything else was to open each show afterwards. The API has always taken prices
 * for a run; only the screen was missing.
 *
 * ── THE LIMIT IS SHOWN, NOT DECIDED, HERE ──────────────────────────────────────────
 * Where a pricing order applies, each class's legal maximum comes from the server (the seat
 * classes answer, read with the resolver checkout uses) and is shown beside the field. A price
 * over it is flagged here so nobody has to wait for the preview, but the server refuses it on
 * its own: this file decides nothing about what may be sold.
 */

export type RunPriceDraft = Record<string, string>;

export interface RunPriceRow {
  seatCategoryId: string;
  name: string;
  houseMinor: number;
  currency: string;
  /** The class it is mapped to, in words; null when unmapped. */
  className: string | null;
  /** The legal band, when a pricing order applies to this class here. */
  maxMinor: number | null;
  minMinor: number | null;
  /** False when the class cannot be sold here at any price (no rate, or unmapped where regulated). */
  sellable: boolean;
  regulated: boolean;
}

const CLASS_NAME: Record<string, string> = {
  REGULAR: 'Regular',
  RECLINER: 'Recliner',
  PREMIUM: 'Premium',
  NON_PREMIUM: 'Non-premium',
};

/** One row per seat category of the screen's layout, with its class and limit when known. */
export function runPriceRows(
  map: Pick<SeatMap, 'categories'> | null | undefined,
  classes: SeatClassMapping[] | null | undefined,
  fallbackCurrency = 'INR',
): RunPriceRow[] {
  if (!map) return [];
  const byId = new Map((classes ?? []).map((c) => [c.id, c]));
  return map.categories.map((c) => {
    const mapped = byId.get(c.id);
    const cls = mapped?.regulatoryClass ?? null;
    const rates = mapped?.classRates ?? [];
    const regulated = rates.some((r) => r.regulated);
    const rate = cls ? rates.find((r) => r.regulatoryClass === cls) : undefined;
    return {
      seatCategoryId: c.id,
      name: c.name,
      houseMinor: c.basePriceMinor,
      currency: mapped?.currency ?? fallbackCurrency,
      className: cls ? (CLASS_NAME[cls] ?? cls) : null,
      maxMinor: rate?.maxMinor ?? null,
      minMinor: rate?.minMinor ?? null,
      // Where an order applies, an unmapped category cannot sell either.
      sellable: !regulated || (rate ? rate.sellable : false),
      regulated,
    };
  });
}

/** The money as an operator types it: 250, or 250.50 when there are paise. */
export function minorToField(minor: number): string {
  return minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2);
}

/** "Up to Rs 250 for a Recliner seat here" - the line under a price field. */
export function limitHint(row: RunPriceRow): string | null {
  if (!row.regulated) return null;
  if (!row.className) {
    return 'Not mapped to a seat class, so these seats will not sell. Map it on Launch readiness.';
  }
  if (!row.sellable) {
    return `No legal rate for a ${row.className} seat here, so these seats will not sell.`;
  }
  if (row.maxMinor != null) {
    return `Legal limit for a ${row.className} seat here: up to ${money(row.maxMinor, row.currency)}.`;
  }
  return null;
}

export interface RunPriceProblem {
  seatCategoryId: string;
  message: string;
}

/**
 * Read every field. A blank or malformed price is refused, never read as free; a price outside
 * the legal band is flagged in the same words the server will use.
 */
export function parseRunPrices(
  rows: RunPriceRow[],
  draft: RunPriceDraft,
): {
  pricing: { seatCategoryId: string; priceMinor: number }[];
  problems: RunPriceProblem[];
} {
  const pricing: { seatCategoryId: string; priceMinor: number }[] = [];
  const problems: RunPriceProblem[] = [];
  for (const row of rows) {
    const raw = (draft[row.seatCategoryId] ?? minorToField(row.houseMinor)).trim();
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
      problems.push({
        seatCategoryId: row.seatCategoryId,
        message: `${row.name}: enter a price, with at most two decimals.`,
      });
      continue;
    }
    const minor = Math.round(Number(raw) * 100);
    if (row.sellable && row.maxMinor != null && minor > row.maxMinor) {
      problems.push({
        seatCategoryId: row.seatCategoryId,
        message: `${row.name}: at most ${money(row.maxMinor, row.currency)} for a ${row.className} seat here.`,
      });
      continue;
    }
    if (row.sellable && row.minMinor != null && minor < row.minMinor) {
      problems.push({
        seatCategoryId: row.seatCategoryId,
        message: `${row.name}: at least ${money(row.minMinor, row.currency)} for a ${row.className} seat here.`,
      });
      continue;
    }
    pricing.push({ seatCategoryId: row.seatCategoryId, priceMinor: minor });
  }
  return { pricing, problems };
}

/** The sign a price field is labelled with: "₹" for rupees, "$" for dollars. */
export function currencySign(currency: string): string {
  try {
    const part = new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
      style: 'currency',
      currency,
    })
      .formatToParts(0)
      .find((p) => p.type === 'currency');
    return part?.value ?? currency;
  } catch {
    return currency;
  }
}
