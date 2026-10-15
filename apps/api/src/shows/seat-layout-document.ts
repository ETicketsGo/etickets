/**
 * Reading a stored seat layout as the editor's document, and writing one back.
 *
 * The document format and its letters live in `@eticketsgo/shared-types` so the console reads
 * them the same way. This file is the database side: from Prisma rows to a document (pure),
 * and from a validated document to rows inside the caller's transaction.
 */
import type { Prisma } from '@prisma/client';
import {
  SEAT_KIND_CODE,
  categoryKeyAt,
  seatKindCode,
  seatKindFromCode,
  seatLabelAt,
  type LayoutDocument,
  type LayoutDocumentRow,
} from '@eticketsgo/shared-types';
import type { SaveLayoutDocumentInput } from '@eticketsgo/validation';

export interface StoredLayout {
  name: string | null;
  categories: {
    id: string;
    name: string;
    colorHex: string | null;
    basePriceMinor: number;
    priceSuggested: boolean;
    regulatoryClass: string | null;
  }[];
  sections: {
    name: string;
    shape: unknown;
    labelX: number | null;
    labelY: number | null;
    tier: string | null;
    rotationDeg: number;
    rows: {
      label: string;
      seats: { label: string; colIndex: number; kind: string; seatCategoryId: string }[];
    }[];
  }[];
  zones: {
    name: string;
    categoryId: string | null;
    capacity: number;
    shape: unknown;
    labelX: number | null;
    labelY: number | null;
  }[];
}

const asShape = (shape: unknown): [number, number][] | null =>
  Array.isArray(shape) &&
  shape.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number'))
    ? (shape as [number, number][])
    : null;

/** The value that occurs most often, or the fallback when there are none. */
function mostCommon(values: string[], fallback: string): string {
  const counts = new Map<string, number>();
  let best = fallback;
  let bestCount = 0;
  for (const v of values) {
    const n = (counts.get(v) ?? 0) + 1;
    counts.set(v, n);
    if (n > bestCount) {
      best = v;
      bestCount = n;
    }
  }
  return best;
}

/**
 * A stored layout as the editor's document.
 *
 * Category keys are the categories' own ids. A section's category is the one most of its seats
 * use; a row or a seat that differs keeps its own, so nothing about the room is lost by loading
 * it into the editor and saving it again. A hole in a row's numbering (a position no seat
 * occupies) reads as a gap, which is what it already was on the buyer's map.
 */
export function toLayoutDocument(layout: StoredLayout): LayoutDocument {
  const fallbackCategory = layout.categories[0]?.id ?? '';
  return {
    name: layout.name ?? 'Layout',
    categories: layout.categories.map((c) => ({
      key: c.id,
      name: c.name,
      colorHex: c.colorHex,
      priceMinor: c.basePriceMinor,
      priceSuggested: c.priceSuggested,
      regulatoryClass: c.regulatoryClass,
    })),
    sections: layout.sections.map((section) => {
      const sectionCategory = mostCommon(
        section.rows.flatMap((r) => r.seats.map((s) => s.seatCategoryId)),
        fallbackCategory,
      );
      return {
        name: section.name,
        categoryKey: sectionCategory,
        shape: asShape(section.shape),
        labelX: section.labelX,
        labelY: section.labelY,
        tier: section.tier,
        rotationDeg: section.rotationDeg,
        rows: section.rows.map((row): LayoutDocumentRow => {
          const seats = [...row.seats].sort((a, b) => a.colIndex - b.colIndex);
          if (seats.length === 0) return { label: row.label, kinds: SEAT_KIND_CODE.GAP };
          const firstCol = seats[0].colIndex;
          const width = seats[seats.length - 1].colIndex - firstCol + 1;
          const byCol = new Map(seats.map((s) => [s.colIndex, s]));
          // A hole takes the row's own category, so it never makes a one-category row mixed.
          const rowCategory = mostCommon(
            seats.map((s) => s.seatCategoryId),
            sectionCategory,
          );
          let kinds = '';
          const labels: string[] = [];
          const cats: string[] = [];
          let defaultLabels = true;
          for (let p = 0; p < width; p += 1) {
            const seat = byCol.get(firstCol + p);
            if (seat) {
              kinds += seatKindCode(seat.kind);
              labels.push(seat.label);
              cats.push(seat.seatCategoryId);
              if (seat.label !== String(p + 1)) defaultLabels = false;
            } else {
              // A position no seat occupies: a gap, with a number no real seat can have.
              kinds += SEAT_KIND_CODE.GAP;
              labels.push(`~${p + 1}`);
              cats.push(rowCategory);
              defaultLabels = false;
            }
          }
          const out: LayoutDocumentRow = { label: row.label, kinds, firstCol };
          if (!defaultLabels) out.labels = labels;
          const distinct = new Set(cats);
          if (distinct.size === 1) {
            const only = cats[0];
            if (only !== sectionCategory) out.categoryKey = only;
          } else {
            out.categoryKeys = cats;
          }
          return out;
        }),
      };
    }),
    zones: layout.zones.map((z) => ({
      name: z.name,
      categoryKey: z.categoryId,
      capacity: z.capacity,
      shape: asShape(z.shape),
      labelX: z.labelX,
      labelY: z.labelY,
    })),
  };
}

/** Seats per INSERT. Postgres binds at most 65535 parameters; a seat binds six. */
const SEAT_INSERT_CHUNK = 2000;

/**
 * Write a validated document into a draft, replacing what it held.
 *
 * The caller has already emptied the draft (seats first, then zones, sections and categories -
 * the only order the foreign keys allow) inside the same transaction. Written level by level in
 * bulk, matched by name, which validation guarantees is unique per level.
 */
export async function writeLayoutDocument(
  tx: Prisma.TransactionClient,
  layoutId: string,
  doc: SaveLayoutDocumentInput,
): Promise<void> {
  await tx.seatMap.update({ where: { id: layoutId }, data: { name: doc.name } });

  const categories = await tx.seatCategory.createManyAndReturn({
    data: doc.categories.map((c, i) => ({
      seatMapId: layoutId,
      name: c.name.trim(),
      colorHex: c.colorHex ?? null,
      basePriceMinor: c.priceMinor,
      priceSuggested: c.priceSuggested ?? false,
      regulatoryClass: c.regulatoryClass ?? null,
      sortOrder: i,
    })),
  });
  const idByName = new Map(categories.map((c) => [c.name, c.id]));
  const categoryId = new Map(
    doc.categories.map((c) => [c.key, idByName.get(c.name.trim()) as string]),
  );

  const sections = await tx.seatSection.createManyAndReturn({
    data: doc.sections.map((s, i) => ({
      seatMapId: layoutId,
      name: s.name.trim(),
      sortOrder: i,
      shape: s.shape ?? undefined,
      labelX: s.labelX ?? null,
      labelY: s.labelY ?? null,
      tier: s.tier ?? null,
      rotationDeg: s.rotationDeg ?? 0,
    })),
  });
  const sectionId = new Map(sections.map((s) => [s.name, s.id]));

  const rows = await tx.seatRow.createManyAndReturn({
    data: doc.sections.flatMap((s) =>
      s.rows.map((r, i) => ({
        sectionId: sectionId.get(s.name.trim()) as string,
        label: r.label.trim(),
        sortOrder: i,
      })),
    ),
  });
  const rowId = new Map(rows.map((r) => [`${r.sectionId}|${r.label}`, r.id]));

  const seats = doc.sections.flatMap((s) => {
    const sid = sectionId.get(s.name.trim()) as string;
    return s.rows.flatMap((r) => {
      const rid = rowId.get(`${sid}|${r.label.trim()}`) as string;
      const firstCol = r.firstCol ?? 0;
      return [...r.kinds].map((code, p) => ({
        seatMapId: layoutId,
        rowId: rid,
        seatCategoryId: categoryId.get(categoryKeyAt(s, r, p)) as string,
        label: seatLabelAt(r, p),
        colIndex: firstCol + p,
        kind: seatKindFromCode(code),
      }));
    });
  });
  for (let i = 0; i < seats.length; i += SEAT_INSERT_CHUNK) {
    await tx.seat.createMany({ data: seats.slice(i, i + SEAT_INSERT_CHUNK) });
  }

  for (const [i, z] of doc.zones.entries()) {
    await tx.seatZone.create({
      data: {
        seatMapId: layoutId,
        name: z.name.trim(),
        categoryId: z.categoryKey ? (categoryId.get(z.categoryKey) ?? null) : null,
        capacity: z.capacity,
        shape: z.shape ?? undefined,
        labelX: z.labelX ?? null,
        labelY: z.labelY ?? null,
        sortOrder: i,
      },
    });
  }
}
