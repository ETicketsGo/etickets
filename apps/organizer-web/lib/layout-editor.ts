import {
  SEAT_KIND_CODE,
  categoryKeyAt,
  seatKindCode,
  seatKindFromCode,
  seatLabelAt,
  usedCategoryKeys,
  type LayoutDocument,
  type LayoutDocumentCategory,
  type LayoutDocumentRow,
  type LayoutDocumentSection,
  type LayoutSeatKind,
} from '@eticketsgo/shared-types';
import {
  CANVAS,
  centreOf,
  clampMove,
  coversNotably,
  freeSpot,
  keepInside,
  normaliseDeg,
  rectangle,
  rotate,
  translate,
  type Pt,
} from './block-geometry';

/**
 * The seat layout editor's operations, as pure functions on the layout document.
 *
 * -- WHY PURE ---------------------------------------------------------------------------
 * Every change an organizer makes - remove a seat, split a section, give a block a category -
 * is a function from one document to the next. Kept out of React, each one is tested for what
 * the room becomes (and for what it must NOT become: a row ending in a gap, a category removed
 * while seats still use it, a merge that silently reprices a row), and the page only decides
 * which one to call. Every function returns a new document; nothing is changed in place, so an
 * undo is simply the previous document.
 */

/** One position in the document: section, row and position indexes. */
export interface SeatRef {
  s: number;
  r: number;
  p: number;
}

export const refKey = (ref: SeatRef) => `${ref.s}:${ref.r}:${ref.p}`;
export const parseRef = (key: string): SeatRef => {
  const [s, r, p] = key.split(':').map(Number);
  return { s, r, p };
};

/** A deep enough copy for one edit: sections and rows are new, strings are immutable anyway. */
function clone(doc: LayoutDocument): LayoutDocument {
  return {
    ...doc,
    categories: doc.categories.map((c) => ({ ...c })),
    sections: doc.sections.map((s) => ({ ...s, rows: s.rows.map((r) => ({ ...r })) })),
    zones: doc.zones.map((z) => ({ ...z })),
  };
}

/** The seat's printed name, "C12". */
export function seatName(doc: LayoutDocument, ref: SeatRef): string {
  const row = doc.sections[ref.s]?.rows[ref.r];
  return row ? `${row.label}${seatLabelAt(row, ref.p)}` : '';
}

export function kindAt(doc: LayoutDocument, ref: SeatRef): LayoutSeatKind {
  return seatKindFromCode(doc.sections[ref.s]?.rows[ref.r]?.kinds[ref.p] ?? 'G');
}

/** Drop gaps from the end of a row: a row that ends in an aisle is a row that ends early. */
function trimTrailingGaps(row: LayoutDocumentRow): LayoutDocumentRow {
  let end = row.kinds.length;
  while (end > 1 && row.kinds[end - 1] === SEAT_KIND_CODE.GAP) end -= 1;
  if (end === row.kinds.length) return row;
  return {
    ...row,
    kinds: row.kinds.slice(0, end),
    ...(row.labels ? { labels: row.labels.slice(0, end) } : {}),
    ...(row.categoryKeys ? { categoryKeys: row.categoryKeys.slice(0, end) } : {}),
  };
}

/**
 * Give every selected position one kind.
 *
 * "Remove" is GAP and "Restore" is SEAT: a removed seat keeps its place and its number, so the
 * seats beside it do not renumber and a restore puts back exactly what was there.
 */
export function setKinds(
  doc: LayoutDocument,
  refs: SeatRef[],
  kind: LayoutSeatKind,
): LayoutDocument {
  const next = clone(doc);
  const code = seatKindCode(kind);
  for (const ref of refs) {
    const row = next.sections[ref.s]?.rows[ref.r];
    if (!row || ref.p < 0 || ref.p >= row.kinds.length) continue;
    row.kinds = row.kinds.slice(0, ref.p) + code + row.kinds.slice(ref.p + 1);
  }
  return next;
}

/** The next seat number after a row's numbered seats. */
function nextNumber(row: LayoutDocumentRow): number {
  let max = row.kinds.length;
  for (const label of row.labels ?? []) {
    const n = Number(label);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max + 1;
}

/** Add seats to the end of a row, numbered on from its last seat. */
export function addSeatsToRow(
  doc: LayoutDocument,
  s: number,
  r: number,
  count: number,
): LayoutDocument {
  const n = Math.max(0, Math.min(200, Math.floor(count)));
  if (n === 0) return doc;
  const next = clone(doc);
  const row = next.sections[s]?.rows[r];
  if (!row) return doc;
  const room = Math.max(0, 200 - row.kinds.length);
  const add = Math.min(n, room);
  if (add === 0) return doc;
  if (row.labels) {
    const start = nextNumber(row);
    row.labels = [...row.labels, ...Array.from({ length: add }, (_, i) => String(start + i))];
  }
  if (row.categoryKeys) {
    const last = row.categoryKeys[row.categoryKeys.length - 1];
    row.categoryKeys = [...row.categoryKeys, ...Array.from({ length: add }, () => last)];
  }
  row.kinds = row.kinds + SEAT_KIND_CODE.SEAT.repeat(add);
  return next;
}

/** Take seats off the end of a row (never the last position). */
export function removeSeatsFromRowEnd(
  doc: LayoutDocument,
  s: number,
  r: number,
  count: number,
): LayoutDocument {
  const next = clone(doc);
  const row = next.sections[s]?.rows[r];
  if (!row) return doc;
  const keep = Math.max(1, row.kinds.length - Math.max(0, Math.floor(count)));
  next.sections[s].rows[r] = trimTrailingGaps({
    ...row,
    kinds: row.kinds.slice(0, keep),
    ...(row.labels ? { labels: row.labels.slice(0, keep) } : {}),
    ...(row.categoryKeys ? { categoryKeys: row.categoryKeys.slice(0, keep) } : {}),
  });
  return next;
}

/** A name not already used, "Front 2", "Front 3"... */
export function uniqueName(taken: Iterable<string>, base: string): string {
  const lower = new Set([...taken].map((t) => t.trim().toLowerCase()));
  if (!lower.has(base.trim().toLowerCase())) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base} ${i}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now()}`;
}

export function renameSection(doc: LayoutDocument, s: number, name: string): LayoutDocument {
  const next = clone(doc);
  if (next.sections[s]) next.sections[s].name = name;
  return next;
}

/**
 * Give a whole section one ticket category. Row and seat exceptions inside it go: the person
 * asked for THE section's category, and a row that silently kept another would be a price
 * they did not see.
 */
export function setSectionCategory(doc: LayoutDocument, s: number, key: string): LayoutDocument {
  const next = clone(doc);
  const section = next.sections[s];
  if (!section) return doc;
  section.categoryKey = key;
  section.rows = section.rows.map(({ categoryKey: _c, categoryKeys: _k, ...row }) => row);
  return next;
}

/** True when some row or seat in the section has a category other than the section's own. */
export function sectionHasMixedCategories(section: LayoutDocumentSection): boolean {
  return section.rows.some(
    (r) =>
      (r.categoryKey && r.categoryKey !== section.categoryKey) ||
      (r.categoryKeys && r.categoryKeys.some((k) => k !== section.categoryKey)),
  );
}

/**
 * Split a section in two before a row: rows before it stay, the rest become a new section right
 * after it, with the same category until the person gives it another. "Rows A-E Premium, F-J
 * Standard" is a split before F and a category on the new part.
 */
export function splitSection(doc: LayoutDocument, s: number, beforeRow: number): LayoutDocument {
  const section = doc.sections[s];
  if (!section || beforeRow <= 0 || beforeRow >= section.rows.length) return doc;
  const next = clone(doc);
  const first = next.sections[s];
  const rest = first.rows.slice(beforeRow);
  first.rows = first.rows.slice(0, beforeRow);
  const name = uniqueName(
    next.sections.map((x) => x.name),
    `${section.name} ${rest[0]?.label ?? ''}`.trim(),
  );
  next.sections.splice(s + 1, 0, { ...first, name, rows: rest });
  return next;
}

/**
 * Why two sections cannot be merged, or null when they can. 'sectioned' is the layout's kind: on
 * a venue map each block has its own place, so blocks are never merged. (A room of rows may carry
 * outlines too - the grid templates draw one - but nothing reads them.)
 */
export function mergeProblem(doc: LayoutDocument, s: number, sectioned = false): string | null {
  const a = doc.sections[s];
  const b = doc.sections[s + 1];
  if (!a || !b) return 'There is no next section to merge with.';
  if (sectioned) return 'Blocks on a venue map cannot be merged; each has its own place.';
  const labels = new Set(a.rows.map((r) => r.label));
  const clash = b.rows.find((r) => labels.has(r.label));
  if (clash) return `Both sections have a row ${clash.label}, so one row would hide the other.`;
  if (a.rows.length + b.rows.length > 120) return 'A section can have at most 120 rows.';
  return null;
}

/**
 * Merge a section with the one after it. The second section's rows keep their own category
 * (as a row category) when it differs, so merging never reprices a seat by itself.
 */
export function mergeWithNext(doc: LayoutDocument, s: number, sectioned = false): LayoutDocument {
  if (mergeProblem(doc, s, sectioned)) return doc;
  const next = clone(doc);
  const a = next.sections[s];
  const b = next.sections[s + 1];
  const moved = b.rows.map((row) => {
    if (row.categoryKey || row.categoryKeys || b.categoryKey === a.categoryKey) return row;
    return { ...row, categoryKey: b.categoryKey };
  });
  a.rows = [...a.rows, ...moved];
  next.sections.splice(s + 1, 1);
  return next;
}

export function removeSection(doc: LayoutDocument, s: number): LayoutDocument {
  if (doc.sections.length <= 1) return doc;
  const next = clone(doc);
  next.sections.splice(s, 1);
  return next;
}

/** A row label after the last one: A..Z, AA, AB... */
export function nextRowLabel(taken: string[]): string {
  const set = new Set(taken);
  const label = (index: number) => {
    let out = '';
    let n = index;
    do {
      out = String.fromCharCode(65 + (n % 26)) + out;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return out;
  };
  for (let i = 0; i < 2000; i += 1) if (!set.has(label(i))) return label(i);
  return `R${taken.length + 1}`;
}

/** Seats (not gaps) in a row. */
export const seatsInRow = (row: Pick<LayoutDocumentRow, 'kinds'>) =>
  [...row.kinds].filter((c) => c !== SEAT_KIND_CODE.GAP).length;

/**
 * Size a block: how many rows, and how many seats in its front row.
 *
 * Rows are added at the back as copies of the last row's width (growing by the same step when
 * the block widens towards the back, as a wedge does) with ordinary seats, and removed from the
 * back. The seats-per-row change is applied to EVERY row by the same amount, so a wedge stays a
 * wedge rather than being squared off.
 */
export function setBlockSize(
  doc: LayoutDocument,
  s: number,
  rows: number,
  frontSeats: number,
): LayoutDocument {
  const section = doc.sections[s];
  if (!section) return doc;
  const wantRows = Math.max(1, Math.min(120, Math.floor(rows)));
  const wantFront = Math.max(1, Math.min(200, Math.floor(frontSeats)));
  let next = clone(doc);
  const sec = next.sections[s];

  // Rows first.
  if (wantRows < sec.rows.length) {
    sec.rows = sec.rows.slice(0, wantRows);
  } else {
    while (sec.rows.length < wantRows) {
      const last = sec.rows[sec.rows.length - 1];
      const before = sec.rows[sec.rows.length - 2];
      const step = before ? Math.max(0, last.kinds.length - before.kinds.length) : 0;
      const width = Math.min(200, last.kinds.length + step);
      // Aisles carry on through the new row; everything else is an ordinary seat.
      const kinds = Array.from({ length: width }, (_, i) =>
        last.kinds[i] === SEAT_KIND_CODE.GAP ? SEAT_KIND_CODE.GAP : SEAT_KIND_CODE.SEAT,
      ).join('');
      sec.rows.push({
        label: nextRowLabel(sec.rows.map((r) => r.label)),
        kinds,
        ...(last.firstCol !== undefined ? { firstCol: last.firstCol } : {}),
        ...(last.categoryKey ? { categoryKey: last.categoryKey } : {}),
      });
    }
  }

  // Then the width, by the same amount on every row.
  const delta = wantFront - seatsInRow(sec.rows[0]);
  for (let r = 0; delta !== 0 && r < sec.rows.length; r += 1) {
    if (delta > 0) {
      next = addSeatsToRow(next, s, r, delta);
      continue;
    }
    // Take |delta| SEATS off the end, stepping over gaps.
    const row = next.sections[s].rows[r];
    let left = -delta;
    let end = row.kinds.length;
    while (left > 0 && end > 1) {
      end -= 1;
      if (row.kinds[end] !== SEAT_KIND_CODE.GAP) left -= 1;
    }
    next = removeSeatsFromRowEnd(next, s, r, row.kinds.length - end);
  }
  return next;
}

// -- Categories --------------------------------------------------------------------

/** Colours for new categories: distinct, and each readable as a seat fill with text on it. */
const PALETTE = ['#2563EB', '#16856A', '#B45309', '#7C3AED', '#DC2626', '#0891B2', '#64748B'];

export function addCategory(doc: LayoutDocument): { doc: LayoutDocument; key: string } {
  const next = clone(doc);
  const key = `new-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const used = new Set(next.categories.map((c) => c.colorHex?.toUpperCase()));
  next.categories.push({
    key,
    name: uniqueName(
      next.categories.map((c) => c.name),
      'New category',
    ),
    colorHex: PALETTE.find((c) => !used.has(c)) ?? PALETTE[next.categories.length % PALETTE.length],
    priceMinor: 0,
    priceSuggested: false,
    regulatoryClass: null,
  });
  return { doc: next, key };
}

export function updateCategory(
  doc: LayoutDocument,
  key: string,
  patch: Partial<Omit<LayoutDocumentCategory, 'key'>>,
): LayoutDocument {
  const next = clone(doc);
  const at = next.categories.findIndex((c) => c.key === key);
  if (at < 0) return doc;
  next.categories[at] = { ...next.categories[at], ...patch };
  return next;
}

/** Why a category cannot be removed, or null when it can. */
export function removeCategoryProblem(doc: LayoutDocument, key: string): string | null {
  if (doc.categories.length <= 1) return 'A layout needs at least one ticket category.';
  if (usedCategoryKeys(doc).has(key) || doc.sections.some((s) => s.categoryKey === key)) {
    const where = doc.sections.filter(
      (s) =>
        s.categoryKey === key ||
        s.rows.some((r) => r.categoryKey === key || r.categoryKeys?.includes(key)),
    );
    return `Used by ${where.length} section${where.length === 1 ? '' : 's'}. Give ${
      where.length === 1 ? 'it' : 'them'
    } another category first.`;
  }
  return null;
}

export function removeCategory(doc: LayoutDocument, key: string): LayoutDocument {
  if (removeCategoryProblem(doc, key)) return doc;
  const next = clone(doc);
  next.categories = next.categories.filter((c) => c.key !== key);
  return next;
}

// -- Selection ---------------------------------------------------------------------

/** Every position in a rectangle between two seats of one section. */
export function rangeBetween(doc: LayoutDocument, a: SeatRef, b: SeatRef): SeatRef[] {
  if (a.s !== b.s) return [b];
  const section = doc.sections[a.s];
  if (!section) return [];
  const [r0, r1] = a.r <= b.r ? [a.r, b.r] : [b.r, a.r];
  const [p0, p1] = a.p <= b.p ? [a.p, b.p] : [b.p, a.p];
  const out: SeatRef[] = [];
  for (let r = r0; r <= r1; r += 1) {
    const width = section.rows[r]?.kinds.length ?? 0;
    for (let p = p0; p <= Math.min(p1, width - 1); p += 1) out.push({ s: a.s, r, p });
  }
  return out;
}

/** Every position of one row. */
export function rowRefs(doc: LayoutDocument, s: number, r: number): SeatRef[] {
  const row = doc.sections[s]?.rows[r];
  return row ? Array.from({ length: row.kinds.length }, (_, p) => ({ s, r, p })) : [];
}

/** Every position of one section. */
export function sectionRefs(doc: LayoutDocument, s: number): SeatRef[] {
  return (doc.sections[s]?.rows ?? []).flatMap((_row, r) => rowRefs(doc, s, r));
}

/** What a selection holds, by kind - for the side panel's sentence about it. */
export function selectionKinds(doc: LayoutDocument, refs: SeatRef[]): Map<LayoutSeatKind, number> {
  const out = new Map<LayoutSeatKind, number>();
  for (const ref of refs) out.set(kindAt(doc, ref), (out.get(kindAt(doc, ref)) ?? 0) + 1);
  return out;
}

/** The category of a position, resolved through row and section. */
export function categoryOf(doc: LayoutDocument, ref: SeatRef): LayoutDocumentCategory | undefined {
  const section = doc.sections[ref.s];
  const row = section?.rows[ref.r];
  if (!section || !row) return undefined;
  const key = categoryKeyAt(section, row, ref.p);
  return doc.categories.find((c) => c.key === key);
}

/**
 * What must be fixed before the document can be saved, in the person's words. The server
 * checks the same things; checking here first means the message sits beside the field.
 */
export function documentProblems(doc: LayoutDocument, priceText: Record<string, string>): string[] {
  const problems: string[] = [];
  const names = new Map<string, number>();
  for (const c of doc.categories) {
    const n = c.name.trim();
    if (!n) problems.push('Give every ticket category a name.');
    names.set(n.toLowerCase(), (names.get(n.toLowerCase()) ?? 0) + 1);
    const text = priceText[c.key];
    if (text !== undefined && text.trim() === '')
      problems.push(`Enter a price for ${n || 'the new category'}.`);
    else if (text !== undefined && !(Number(text) >= 0))
      problems.push(`The price of ${n} is not a number.`);
  }
  for (const [name, count] of names)
    if (name && count > 1) problems.push(`Two ticket categories are called "${name}".`);
  const sectionNames = new Map<string, number>();
  for (const s of doc.sections) {
    const n = s.name.trim();
    if (!n) problems.push('Give every section a name.');
    sectionNames.set(n.toLowerCase(), (sectionNames.get(n.toLowerCase()) ?? 0) + 1);
  }
  for (const [name, count] of sectionNames)
    if (name && count > 1) problems.push(`Two sections are called "${name}".`);
  return [...new Set(problems)];
}

// -- Blocks on a venue map ------------------------------------------------------------------

/** What a new block looks like: a plain rectangle, or the outline of a block already there. */
export type NewBlockShape = { kind: 'RECTANGLE' } | { kind: 'COPY'; of: number };

export interface NewBlock {
  name: string;
  shape: NewBlockShape;
  rows: number;
  seatsPerRow: number;
  categoryKey: string;
}

/** Outlines a new block must not land on: every placed block, and the stage or screen. */
function takenShapes(doc: LayoutDocument, focal: Pt[] | null, except?: number): Pt[][] {
  const out = doc.sections
    .filter((s, i) => i !== except && Array.isArray(s.shape) && s.shape.length >= 3)
    .map((s) => s.shape as Pt[]);
  if (focal && focal.length >= 3) out.push(focal);
  return out;
}

/**
 * The outline a new rectangular block gets. The map draws no seats, so this is a diagram: wide
 * enough for its name and price to fit, and growing with the block so a big block looks big.
 */
export function rectangleFor(rows: number, seatsPerRow: number): Pt[] {
  const width = Math.max(90, Math.min(360, seatsPerRow * 9 + 30));
  const height = Math.max(60, Math.min(300, rows * 12 + 24));
  return rectangle(0, 0, width, height);
}

/**
 * Why a block cannot be added as asked, or null when it can. The server checks the same limits;
 * here the message can sit beside the field.
 */
export function newBlockProblem(doc: LayoutDocument, block: NewBlock): string | null {
  const name = block.name.trim();
  if (!name) return 'Give the block a name.';
  if (doc.sections.some((s) => s.name.trim().toLowerCase() === name.toLowerCase()))
    return `There is already a block called ${name}.`;
  if (!Number.isInteger(block.rows) || block.rows < 1 || block.rows > 120)
    return 'A block can have 1 to 120 rows.';
  if (!Number.isInteger(block.seatsPerRow) || block.seatsPerRow < 1 || block.seatsPerRow > 200)
    return 'A row can have 1 to 200 seats.';
  if (!doc.categories.some((c) => c.key === block.categoryKey))
    return 'Choose a ticket category for the block.';
  if (doc.sections.length >= 400) return 'A layout can have at most 400 blocks.';
  if (block.shape.kind === 'COPY' && !doc.sections[block.shape.of]?.shape)
    return 'That block is not on the map, so its shape cannot be copied.';
  return null;
}

/**
 * Add a block: its rows of ordinary seats, its category, and an outline on empty ground.
 *
 * A copied outline lands as near its source as there is room, so "another one like 104" appears
 * beside 104; a rectangle lands nearest the middle of the map. Either way the organizer then
 * drags or nudges it into place. Returns the document and the new block's index.
 */
export function addBlock(
  doc: LayoutDocument,
  block: NewBlock,
  focal: Pt[] | null,
): { doc: LayoutDocument; index: number } {
  if (newBlockProblem(doc, block)) return { doc, index: -1 };
  const next = clone(doc);
  const source = block.shape.kind === 'COPY' ? doc.sections[block.shape.of] : null;
  const outline = source?.shape
    ? (source.shape as Pt[])
    : rectangleFor(block.rows, block.seatsPerRow);
  const prefer: Pt = source?.shape ? centreOf(source.shape as Pt[]) : [CANVAS / 2, CANVAS / 2];
  const shape = freeSpot(outline, takenShapes(doc, focal), prefer);
  const [labelX, labelY] = centreOf(shape);
  const rows: LayoutDocumentRow[] = Array.from({ length: block.rows }, (_v, r) => ({
    label: rowLabelAt(r),
    kinds: SEAT_KIND_CODE.SEAT.repeat(block.seatsPerRow),
  }));
  next.sections.push({
    name: block.name.trim(),
    categoryKey: block.categoryKey,
    shape,
    labelX,
    labelY,
    tier: source?.tier ?? 'FLOOR',
    rotationDeg: source?.rotationDeg ?? 0,
    rows,
  });
  return { doc: next, index: next.sections.length - 1 };
}

/** A, B, ... Z, AA: the label of the row at an index. */
function rowLabelAt(index: number): string {
  let out = '';
  let n = index;
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** Move a block's outline and its label together, stopping at the edge of the map. */
export function moveBlock(doc: LayoutDocument, s: number, dx: number, dy: number): LayoutDocument {
  const section = doc.sections[s];
  if (!section?.shape || section.shape.length < 3) return doc;
  const [mx, my] = clampMove(section.shape as Pt[], dx, dy);
  if (mx === 0 && my === 0) return doc;
  const next = clone(doc);
  const sec = next.sections[s];
  sec.shape = translate(section.shape as Pt[], mx, my);
  if (sec.labelX !== null) sec.labelX = Math.round(sec.labelX + mx);
  if (sec.labelY !== null) sec.labelY = Math.round(sec.labelY + my);
  return next;
}

/**
 * Turn a block around its own middle, clockwise for a positive angle. Its label turns with it
 * (the words stay upright on the map), and a block turned past the edge is moved back inside.
 */
export function rotateBlock(doc: LayoutDocument, s: number, deg: number): LayoutDocument {
  const section = doc.sections[s];
  if (!section?.shape || section.shape.length < 3 || deg % 360 === 0) return doc;
  const about = centreOf(section.shape as Pt[]);
  const turned = rotate(section.shape as Pt[], deg, about);
  const inside = keepInside(turned);
  const [sx, sy] = [inside[0][0] - turned[0][0], inside[0][1] - turned[0][1]];
  const label: Pt =
    section.labelX !== null && section.labelY !== null
      ? rotate([[section.labelX, section.labelY]], deg, about)[0]
      : about;
  const next = clone(doc);
  const sec = next.sections[s];
  sec.shape = inside;
  sec.labelX = label[0] + sx;
  sec.labelY = label[1] + sy;
  sec.rotationDeg = normaliseDeg((section.rotationDeg ?? 0) + deg);
  return next;
}

/**
 * Put a block that has no outline onto the map, as a rectangle on empty ground. A layout can
 * carry such a block (an older venue, a hand-made section); until now it could only be listed.
 */
export function placeBlock(doc: LayoutDocument, s: number, focal: Pt[] | null): LayoutDocument {
  const section = doc.sections[s];
  if (!section || (section.shape && section.shape.length >= 3)) return doc;
  const widest = Math.max(1, ...section.rows.map((r) => r.kinds.length));
  const shape = freeSpot(rectangleFor(section.rows.length, widest), takenShapes(doc, focal, s), [
    CANVAS / 2,
    CANVAS / 2,
  ]);
  const next = clone(doc);
  const [labelX, labelY] = centreOf(shape);
  Object.assign(next.sections[s], { shape, labelX, labelY });
  return next;
}

/** What a block's outline overlaps, by name: other blocks, and the stage itself. */
export function blockOverlaps(
  doc: LayoutDocument,
  s: number,
  focal: { shape: Pt[] | null; label: string } | null,
): string[] {
  const section = doc.sections[s];
  if (!section?.shape || section.shape.length < 3) return [];
  const mine = section.shape as Pt[];
  const names = doc.sections
    .filter(
      (o, i) => i !== s && o.shape && o.shape.length >= 3 && coversNotably(mine, o.shape as Pt[]),
    )
    .map((o) => o.name);
  if (focal?.shape && focal.shape.length >= 3 && coversNotably(mine, focal.shape))
    names.push(`the ${focal.label.toLowerCase()}`);
  return names;
}
