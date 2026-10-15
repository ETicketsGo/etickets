import { reconcileSeats, type SeatReconciliation } from '@eticketsgo/shared-types';
import type { LayoutTemplateFitMode, LayoutTemplateOutline } from '@eticketsgo/web-kit';
import type { SectionDraft } from './seat-layout';

/**
 * Turning a gallery template into the row-by-row generator's own form.
 *
 * ── WHY PRE-FILL AND NOT JUST BUILD ────────────────────────────────────────────────
 * A cinema's first layout is made in the generator, where every row, aisle, accessible place
 * and price can be adjusted before anything is written. Choosing a grid template fills that
 * form rather than bypassing it, so the organizer starts from a real room and still sees - and
 * can change - every number before pressing Generate.
 *
 * The form is filled from the template's OUTLINE, which the API derives from the same
 * geometry it would write. So the room the form describes is the room the template is: same
 * rows, same width, same aisle, same wheelchair bay - and the same bookable count the card
 * promised. `templateBookable` and the generator's `capacitySummary` must agree, and a test
 * holds them to it.
 */

/** What a template's card promises: its counts by the shared rule. */
export function templateReconciliation(outline: LayoutTemplateOutline): SeatReconciliation {
  return reconcileSeats(outline.kindCounts);
}

export function templateBookable(outline: LayoutTemplateOutline): number {
  return templateReconciliation(outline).bookable;
}

/** Positions present in every one of the given rows; positions missing from any are dropped. */
function inEveryRow(byRow: Map<string, number[]>, rows: string[]): number[] {
  if (rows.length === 0) return [];
  const [first, ...rest] = rows.map((r) => new Set(byRow.get(r) ?? []));
  return [...first].filter((p) => rest.every((set) => set.has(p))).sort((a, b) => a - b);
}

function union(byRow: Map<string, number[]>): number[] {
  return [...new Set([...byRow.values()].flat())].sort((a, b) => a - b);
}

/**
 * The generator sections for a GRID template, priced from one base price.
 *
 * `basePrice` is in major units, as the form takes it. Each section's price is scaled by its
 * category's weight, the way the API prices a template: a starting point, not advice.
 */
export function draftsFromOutline(
  outline: LayoutTemplateOutline,
  basePrice: string,
): SectionDraft[] {
  // A blank box is "no price yet", not zero: Number('') is 0, and a free seat is a decision.
  const base = basePrice.trim() === '' ? Number.NaN : Number(basePrice);
  const weightOf = new Map(outline.categories.map((c) => [c.name, c]));
  return outline.sections.map((section) => {
    const kinds = (kind: 'WHEELCHAIR' | 'COMPANION' | 'GAP') => {
      const byRow = new Map<string, number[]>();
      for (const k of section.seatKinds) if (k.kind === kind) byRow.set(k.rowLabel, k.seats);
      return byRow;
    };
    const gaps = kinds('GAP');
    const wheelchair = kinds('WHEELCHAIR');
    const companion = kinds('COMPANION');
    const bayRows = [...new Set([...wheelchair.keys(), ...companion.keys()])];
    const category = weightOf.get(section.categoryName);
    const price =
      Number.isFinite(base) && base >= 0
        ? String(Math.round(base * (category?.priceWeight ?? 1)))
        : '';
    return {
      name: section.name,
      categoryName: section.categoryName,
      colorHex: category?.colorHex ?? '#2563EB',
      basePrice: price,
      rowLabels: section.rowLabels.join(', '),
      seatsPerRow: String(section.positions),
      // An aisle runs the length of the block, so it is the positions that are a gap in EVERY row.
      gapSeats: inEveryRow(gaps, section.rowLabels).join(', '),
      wheelchairSeats: union(wheelchair).join(', '),
      companionSeats: union(companion).join(', '),
      accessibleRows: bayRows.join(', '),
    };
  });
}

/**
 * What a template's card says about its size, once it has been sized to the space.
 *
 * A template used to be offered at its own fixed size - a 150-seat screen was shown and built
 * "Cinema, 180 seats". Sized to the space, the card says "About 150 seats"; and where the shape
 * cannot get that small or that big it says so in words, instead of quietly building the
 * nearest thing.
 */
export function templateSizeNote(outline: LayoutTemplateOutline): {
  capacity: string;
  warning: string | null;
} {
  const seats = templateBookable(outline).toLocaleString();
  const fit = outline.fit;
  if (!fit) return { capacity: `${seats} seats`, warning: null };
  const target = fit.target.toLocaleString();
  if (fit.verdict === 'TOO_BIG')
    return {
      capacity: `${seats} seats`,
      warning: `This shape cannot be made as small as ${target}. The smallest is ${seats} seats.`,
    };
  if (fit.verdict === 'TOO_SMALL')
    return {
      capacity: `${seats} seats`,
      warning: `This shape cannot hold ${target}. The largest is ${seats} seats.`,
    };
  // The exact number it will build, when it can be built at exactly the planned size.
  if (fit.options?.exact) {
    return { capacity: `${fit.options.exact.seats.toLocaleString()} seats`, warning: null };
  }
  return { capacity: `About ${seats} seats`, warning: null };
}

/** One size the person can choose for a template, worded for a radio button. */
export interface TemplateSizeChoice {
  mode: LayoutTemplateFitMode;
  seats: number;
  label: string;
  detail: string;
}

/**
 * The sizes a template can be built at for the space, as choices.
 *
 * -- WHY ----------------------------------------------------------------------------------
 * The owner planned 100 seats and was built 110 with no say: the card said "About 110" and the
 * button built it. Now the exact size comes first when the shape can reach it (by taking a seat
 * off the ends of the longest rows), and the nearest full-row rooms below and above are offered
 * beside it, so "fewer" is a choice and never a surprise.
 */
export function templateSizeChoices(outline: LayoutTemplateOutline): TemplateSizeChoice[] {
  const options = outline.fit?.options;
  if (!options) return [];
  const out: TemplateSizeChoice[] = [];
  const { exact, below, above } = options;
  if (exact) {
    out.push({
      mode: 'EXACT',
      seats: exact.seats,
      label: `Exactly ${exact.seats.toLocaleString()} seats`,
      detail:
        exact.trimmed > 0
          ? `Made exact by taking ${exact.trimmed} seat${exact.trimmed === 1 ? '' : 's'} off the ends of the longest rows.`
          : 'Every row full.',
    });
  }
  if (below && below.seats !== exact?.seats) {
    out.push({
      mode: 'AT_MOST',
      seats: below.seats,
      label: `${below.seats.toLocaleString()} seats (fewer)`,
      detail: 'Every row full.',
    });
  }
  if (above && above.seats !== exact?.seats) {
    out.push({
      mode: 'AT_LEAST',
      seats: above.seats,
      label: `${above.seats.toLocaleString()} seats (more)`,
      detail:
        outline.fit?.verdict === 'TOO_BIG' ? 'The smallest this shape can be.' : 'Every row full.',
    });
  }
  return out;
}
