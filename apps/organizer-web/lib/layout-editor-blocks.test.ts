import { describe, expect, it } from 'vitest';
import { countLayoutDocument, type LayoutDocument } from '@eticketsgo/shared-types';
import { boxOf, overlaps, type Pt } from './block-geometry';
import {
  addBlock,
  blockOverlaps,
  moveBlock,
  newBlockProblem,
  placeBlock,
  removeSection,
  rotateBlock,
} from './layout-editor';

const stage: Pt[] = [
  [400, 40],
  [600, 40],
  [600, 100],
  [400, 100],
];

/** A small sectioned room: two blocks in front of a stage, two categories. */
function arena(): LayoutDocument {
  const block = (name: string, x: number, categoryKey: string) => ({
    name,
    categoryKey,
    shape: [
      [x, 150],
      [x + 150, 150],
      [x + 150, 250],
      [x, 250],
    ] as [number, number][],
    labelX: x + 75,
    labelY: 200,
    tier: 'LOWER',
    rotationDeg: 0,
    rows: ['A', 'B'].map((label) => ({ label, kinds: 'SSSSS' })),
  });
  return {
    name: 'Arena',
    categories: [
      {
        key: 'prem',
        name: 'Premium',
        colorHex: '#B45309',
        priceMinor: 7500,
        priceSuggested: false,
        regulatoryClass: null,
      },
      {
        key: 'std',
        name: 'Standard',
        colorHex: '#2563EB',
        priceMinor: 4999,
        priceSuggested: false,
        regulatoryClass: null,
      },
    ],
    sections: [block('Front 1', 300, 'prem'), block('Front 2', 500, 'std')],
    zones: [],
  };
}

describe('adding a block', () => {
  it('adds rows x seats at the chosen category, on empty ground', () => {
    const before = arena();
    const { doc, index } = addBlock(
      before,
      { name: 'Floor', shape: { kind: 'RECTANGLE' }, rows: 5, seatsPerRow: 10, categoryKey: 'std' },
      stage,
    );
    expect(index).toBe(2);
    const floor = doc.sections[2];
    expect(floor.name).toBe('Floor');
    expect(floor.categoryKey).toBe('std');
    expect(floor.rows.map((r) => r.label)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(floor.rows.every((r) => r.kinds === 'SSSSSSSSSS')).toBe(true);
    expect(countLayoutDocument(doc).bookable).toBe(countLayoutDocument(before).bookable + 50);
    // On empty ground: over no other block and not on the stage.
    const shape = floor.shape as Pt[];
    expect(before.sections.some((s) => overlaps(shape, s.shape as Pt[]))).toBe(false);
    expect(overlaps(shape, stage)).toBe(false);
    // Its label sits inside its own outline.
    const b = boxOf(shape);
    expect(floor.labelX).toBeGreaterThan(b.minX);
    expect(floor.labelX).toBeLessThan(b.maxX);
    // The document it came from is untouched (undo is the previous document).
    expect(before.sections).toHaveLength(2);
  });

  it("copies another block's outline, beside it, so the room keeps one family of shapes", () => {
    const { doc } = addBlock(
      arena(),
      {
        name: 'Front 3',
        shape: { kind: 'COPY', of: 1 },
        rows: 2,
        seatsPerRow: 5,
        categoryKey: 'std',
      },
      stage,
    );
    const copy = doc.sections[2];
    const source = doc.sections[1];
    const size = (s: Pt[]) => {
      const b = boxOf(s);
      return [b.maxX - b.minX, b.maxY - b.minY];
    };
    expect(size(copy.shape as Pt[])).toEqual(size(source.shape as Pt[]));
    expect(copy.tier).toBe('LOWER');
    expect(overlaps(copy.shape as Pt[], source.shape as Pt[])).toBe(false);
  });

  it('refuses a duplicate name, an impossible size or a missing category, in words', () => {
    const doc = arena();
    const ok = {
      name: 'X',
      shape: { kind: 'RECTANGLE' as const },
      rows: 2,
      seatsPerRow: 2,
      categoryKey: 'std',
    };
    expect(newBlockProblem(doc, ok)).toBeNull();
    expect(newBlockProblem(doc, { ...ok, name: 'front 1' })).toMatch(/already a block called/);
    expect(newBlockProblem(doc, { ...ok, rows: 0 })).toMatch(/1 to 120 rows/);
    expect(newBlockProblem(doc, { ...ok, seatsPerRow: 201 })).toMatch(/1 to 200 seats/);
    expect(newBlockProblem(doc, { ...ok, categoryKey: 'nope' })).toMatch(/ticket category/);
    expect(addBlock(doc, { ...ok, name: '' }, stage).index).toBe(-1);
  });
});

describe('moving, turning and removing a block', () => {
  it('moves the outline and the label together, never off the map', () => {
    const doc = moveBlock(arena(), 0, 40, -20);
    expect((doc.sections[0].shape as Pt[])[0]).toEqual([340, 130]);
    expect([doc.sections[0].labelX, doc.sections[0].labelY]).toEqual([415, 180]);
    // Dragged far past the left edge: it stops at x = 0.
    const far = moveBlock(arena(), 0, -5000, 0);
    expect(boxOf(far.sections[0].shape as Pt[]).minX).toBe(0);
    // Seats are not touched by a move.
    expect(far.sections[0].rows).toEqual(arena().sections[0].rows);
  });

  it('turns a block and records the turn, keeping it inside the map', () => {
    const doc = rotateBlock(arena(), 0, 15);
    expect(doc.sections[0].rotationDeg).toBe(15);
    expect(doc.sections[0].shape).not.toEqual(arena().sections[0].shape);
    const back = rotateBlock(doc, 0, -15);
    expect(back.sections[0].rotationDeg).toBe(0);
    const b = boxOf(back.sections[0].shape as Pt[]);
    // A turn and its undo land within a unit of where it started (points are whole numbers).
    expect(Math.abs(b.minX - 300)).toBeLessThanOrEqual(1);
    expect(Math.abs(b.maxY - 250)).toBeLessThanOrEqual(1);
  });

  it('names what a block covers, the stage included', () => {
    const onTop = moveBlock(arena(), 1, -150, 0);
    expect(blockOverlaps(onTop, 1, { shape: stage, label: 'STAGE' })).toEqual(['Front 1']);
    const onStage = moveBlock(arena(), 0, 150, -100);
    expect(blockOverlaps(onStage, 0, { shape: stage, label: 'STAGE' })).toContain('the stage');
    expect(blockOverlaps(arena(), 0, { shape: stage, label: 'STAGE' })).toEqual([]);
  });

  it('puts a block with no outline onto the map', () => {
    const doc = arena();
    doc.sections[1] = { ...doc.sections[1], shape: null, labelX: null, labelY: null };
    const placed = placeBlock(doc, 1, stage);
    const shape = placed.sections[1].shape as Pt[];
    expect(shape.length).toBe(4);
    expect(overlaps(shape, doc.sections[0].shape as Pt[])).toBe(false);
  });

  it('removes a block but never the last one', () => {
    expect(removeSection(arena(), 0).sections.map((s) => s.name)).toEqual(['Front 2']);
    const one = removeSection(arena(), 0);
    expect(removeSection(one, 0)).toBe(one);
  });
});
