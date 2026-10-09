import { reconcileSeats, type SeatReconciliation } from '@eticketsgo/shared-types';
import type { LayoutTemplateOutline } from '@eticketsgo/web-kit';
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
