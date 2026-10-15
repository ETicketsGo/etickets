/**
 * A seat layout as one editable document: categories, sections, rows and seat kinds.
 *
 * -- WHY A DOCUMENT AND NOT A FORM ------------------------------------------------------
 * The only way to change a draft used to be "rebuild it from another template". A room is
 * shaped by small, specific changes - remove the two seats behind a pillar, add two at the end
 * of row C, make block 104 Premium - and none of those could be said. The editor loads the
 * draft as this document, the person changes it in place, and saving writes it back whole.
 *
 * -- WHY ROWS ARE STRINGS --------------------------------------------------------------
 * A stadium is fourteen thousand seats. As objects that is close to a megabyte of JSON, past
 * the API's body limit and slow on a phone. Each row is instead a string with one letter per
 * position ("SSSGSSSWC"), which keeps the same stadium near forty kilobytes. Seat numbers are
 * the position plus one, as every generator in the product writes them; a row whose numbers
 * differ (an imported room) carries them explicitly in `labels`.
 *
 * Pure, so the API and the console use the same reading of the same letters.
 */

/** Every kind a position in a layout can be. */
export const LAYOUT_SEAT_KINDS = [
  'SEAT',
  'GAP',
  'WHEELCHAIR',
  'COMPANION',
  'RESTRICTED_VIEW',
  'HOUSE',
] as const;
export type LayoutSeatKind = (typeof LAYOUT_SEAT_KINDS)[number];

/** One letter per kind, for the row strings. */
export const SEAT_KIND_CODE: Record<LayoutSeatKind, string> = {
  SEAT: 'S',
  GAP: 'G',
  WHEELCHAIR: 'W',
  COMPANION: 'C',
  RESTRICTED_VIEW: 'R',
  HOUSE: 'H',
};

const KIND_BY_CODE: Record<string, LayoutSeatKind> = Object.fromEntries(
  Object.entries(SEAT_KIND_CODE).map(([kind, code]) => [code, kind as LayoutSeatKind]),
);

/** The letters a row string may contain. */
export const SEAT_KIND_CODES = Object.values(SEAT_KIND_CODE).join('');

/** What each kind is called on screen. Plain words, never the code. */
export const SEAT_KIND_LABEL: Record<LayoutSeatKind, string> = {
  SEAT: 'Seat',
  GAP: 'Gap (no seat)',
  WHEELCHAIR: 'Wheelchair space',
  COMPANION: 'Companion seat',
  RESTRICTED_VIEW: 'Restricted view',
  HOUSE: 'House seat (held back)',
};

/** The kind a letter stands for. An unknown letter reads as an ordinary seat. */
export function seatKindFromCode(code: string): LayoutSeatKind {
  return KIND_BY_CODE[code] ?? 'SEAT';
}

/** The letter for a kind. A kind this file does not know is written as an ordinary seat. */
export function seatKindCode(kind: string): string {
  return SEAT_KIND_CODE[kind as LayoutSeatKind] ?? 'S';
}

/**
 * Whether a kind can ever be sold. Only a gap cannot: a house seat is a real seat, held back
 * at each session and released there; a restricted-view seat is sold with a warning.
 */
export function isSellableLayoutKind(kind: string): boolean {
  return kind !== 'GAP';
}

export interface LayoutDocumentCategory {
  /** Stable within one editing session. The server assigns new ids on save. */
  key: string;
  name: string;
  colorHex: string | null;
  priceMinor: number;
  /**
   * True while the price is one a template worked out, not one the organizer typed or accepted.
   * Shown as "suggested" until it is changed or accepted.
   */
  priceSuggested: boolean;
  /** Carried through untouched: a rate-capped market refuses a category without it. */
  regulatoryClass: string | null;
}

export interface LayoutDocumentRow {
  label: string;
  /** One letter per position, front of the row first. See SEAT_KIND_CODE. */
  kinds: string;
  /** Seat numbers, only when they are not simply 1, 2, 3, ... by position. */
  labels?: string[];
  /** Where the row starts on the plan. Kept so a re-saved room lines up as it did. */
  firstCol?: number;
  /** A category for this row only, when it differs from its section's. */
  categoryKey?: string;
  /** A category per position, only when one row mixes categories (an imported room). */
  categoryKeys?: string[];
}

export interface LayoutDocumentSection {
  name: string;
  categoryKey: string;
  /** The block's outline on a venue map. Null on a room of rows. */
  shape: [number, number][] | null;
  labelX: number | null;
  labelY: number | null;
  tier: string | null;
  rotationDeg: number;
  rows: LayoutDocumentRow[];
}

export interface LayoutDocumentZone {
  name: string;
  categoryKey: string | null;
  capacity: number;
  shape: [number, number][] | null;
  labelX: number | null;
  labelY: number | null;
}

export interface LayoutDocument {
  name: string;
  categories: LayoutDocumentCategory[];
  sections: LayoutDocumentSection[];
  zones: LayoutDocumentZone[];
}

/** The seat number at a position of a row. */
export function seatLabelAt(row: Pick<LayoutDocumentRow, 'labels'>, position: number): string {
  return row.labels?.[position] ?? String(position + 1);
}

/** The category a position belongs to. */
export function categoryKeyAt(
  section: Pick<LayoutDocumentSection, 'categoryKey'>,
  row: Pick<LayoutDocumentRow, 'categoryKey' | 'categoryKeys'>,
  position: number,
): string {
  return row.categoryKeys?.[position] ?? row.categoryKey ?? section.categoryKey;
}

/** The numbers an editor shows live, by the same rule as `reconcileSeats`. */
export interface LayoutDocumentCounts {
  positions: number;
  aisles: number;
  seats: number;
  wheelchair: number;
  companion: number;
  accessible: number;
  restricted: number;
  house: number;
  /** Seats a buyer can choose at a new session: every seat except gaps and house seats. */
  bookable: number;
}

export function countLayoutRows(
  rows: Iterable<Pick<LayoutDocumentRow, 'kinds'>>,
): LayoutDocumentCounts {
  const n = {
    positions: 0,
    aisles: 0,
    seats: 0,
    wheelchair: 0,
    companion: 0,
    accessible: 0,
    restricted: 0,
    house: 0,
    bookable: 0,
  };
  for (const row of rows) {
    for (const code of row.kinds) {
      const kind = seatKindFromCode(code);
      n.positions += 1;
      if (kind === 'GAP') n.aisles += 1;
      else if (kind === 'WHEELCHAIR') n.wheelchair += 1;
      else if (kind === 'COMPANION') n.companion += 1;
      else if (kind === 'RESTRICTED_VIEW') n.restricted += 1;
      else if (kind === 'HOUSE') n.house += 1;
    }
  }
  n.seats = n.positions - n.aisles;
  n.accessible = n.wheelchair + n.companion;
  n.bookable = n.seats - n.house;
  return n;
}

export function countLayoutDocument(doc: {
  sections: { rows: Pick<LayoutDocumentRow, 'kinds'>[] }[];
}): LayoutDocumentCounts {
  return countLayoutRows(doc.sections.flatMap((s) => s.rows));
}

/** Which categories some seat or standing zone uses. An unused one can be removed. */
export function usedCategoryKeys(doc: Pick<LayoutDocument, 'sections' | 'zones'>): Set<string> {
  const used = new Set<string>();
  for (const section of doc.sections) {
    for (const row of section.rows) {
      for (let p = 0; p < row.kinds.length; p += 1) {
        if (row.kinds[p] === SEAT_KIND_CODE.GAP) continue;
        used.add(categoryKeyAt(section, row, p));
      }
    }
  }
  for (const zone of doc.zones) if (zone.categoryKey) used.add(zone.categoryKey);
  return used;
}
