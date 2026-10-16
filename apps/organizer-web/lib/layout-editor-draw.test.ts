import { describe, expect, it } from 'vitest';
import { countLayoutDocument, type LayoutDocument } from '@eticketsgo/shared-types';
import {
  labelPointOf,
  rectangleFromCorners,
  sameCorner,
  selfCrosses,
  type Pt,
} from './block-geometry';
import {
  addBlock,
  blockOverlaps,
  drawnOutlineProblem,
  moveBlock,
  newBlockProblem,
  outlineOverlaps,
  rectangleFor,
  rotateBlock,
  suggestBlockSize,
  type NewBlock,
} from './layout-editor';

/*
  The owner's ask: "blocks can't be drawn". What must hold: an outline drawn on the map (a dragged
  rectangle, or corners tapped one by one) becomes a block of the rows and seats the person asks
  for, EXACTLY where it was drawn, with its name inside it; an outline that cannot be a block
  (too few corners, crossing itself, too small to tap) is refused in words; and the block then
  moves, turns and warns about overlaps like any other.
*/

const stage: Pt[] = [
  [400, 40],
  [600, 40],
  [600, 100],
  [400, 100],
];

function arena(): LayoutDocument {
  const block = (name: string, x: number) => ({
    name,
    categoryKey: 'std',
    shape: [
      [x, 150],
      [x + 150, 150],
      [x + 150, 250],
      [x, 250],
    ] as Pt[],
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
        key: 'std',
        name: 'Standard',
        colorHex: '#2563EB',
        priceMinor: 4999,
        priceSuggested: false,
        regulatoryClass: null,
      },
    ],
    sections: [block('Front 1', 300), block('Front 2', 500)],
    zones: [],
  };
}

/** An L-shaped floor in the bottom-left corner, as a person would tap it out. */
const floorL: Pt[] = [
  [100, 600],
  [400, 600],
  [400, 700],
  [200, 700],
  [200, 900],
  [100, 900],
];

const drawn = (points: Pt[], over: Partial<NewBlock> = {}): NewBlock => ({
  name: 'Walk Drawn',
  shape: { kind: 'DRAWN', points },
  rows: 6,
  seatsPerRow: 12,
  categoryKey: 'std',
  ...over,
});

describe('a drawn outline', () => {
  it('turns a drag in any direction into the same rectangle, kept on the map', () => {
    const forward = rectangleFromCorners([100, 600], [300, 800]);
    expect(forward).toEqual([
      [100, 600],
      [300, 600],
      [300, 800],
      [100, 800],
    ]);
    expect(rectangleFromCorners([300, 800], [100, 600])).toEqual(forward);
    expect(rectangleFromCorners([-40, 900], [200, 1200])).toEqual([
      [0, 900],
      [200, 900],
      [200, 1000],
      [0, 1000],
    ]);
  });

  it('is refused in words when it cannot be a block', () => {
    expect(drawnOutlineProblem([[1, 1]])).toMatch(/at least 3 corners/);
    // Corners tapped out of order: a bow tie.
    const bowTie: Pt[] = [
      [100, 100],
      [300, 300],
      [300, 100],
      [100, 300],
    ];
    expect(selfCrosses(bowTie)).toBe(true);
    expect(drawnOutlineProblem(bowTie)).toMatch(/crosses itself/);
    expect(drawnOutlineProblem(rectangleFromCorners([100, 100], [110, 110]))).toMatch(/too small/);
    expect(selfCrosses(floorL)).toBe(false);
    expect(drawnOutlineProblem(floorL)).toBeNull();
  });

  it('treats a second tap on the same spot as the same corner', () => {
    expect(sameCorner([100, 100], [102, 99])).toBe(true);
    expect(sameCorner([100, 100], [110, 100])).toBe(false);
  });

  it('puts the name inside the block, even when the shape is an L', () => {
    // The corners' average of this L is outside it, in the notch.
    const label = labelPointOf(floorL);
    expect(label[0]).toBeGreaterThanOrEqual(100);
    expect(label[0]).toBeLessThanOrEqual(400);
    const inL =
      (label[1] >= 600 && label[1] <= 700 && label[0] <= 400) ||
      (label[1] > 700 && label[1] <= 900 && label[0] <= 200);
    expect(inL).toBe(true);
    expect(labelPointOf(rectangleFromCorners([100, 100], [300, 200]))).toEqual([200, 150]);
  });

  it("suggests seats in the room's own scale: drawn as big as a block, as many seats as it has", () => {
    // Front 1 is 150 x 100 on the map with 2 rows of 5.
    const likeFront1 = rectangleFromCorners([100, 600], [250, 700]);
    expect(suggestBlockSize(likeFront1, arena())).toEqual({ rows: 2, seatsPerRow: 5 });
    // Twice as wide: twice the seats, in longer rows rather than more of them.
    const wide = suggestBlockSize(rectangleFromCorners([100, 600], [400, 700]), arena());
    expect(wide).toEqual({ rows: 2, seatsPerRow: 10 });
  });

  it('with no seated block to compare with, suggests what Add a block would draw', () => {
    const box = rectangleFor(8, 20);
    expect(suggestBlockSize(box)).toEqual({ rows: 8, seatsPerRow: 20 });
    // The L covers 5/12 of its box, so fewer seats per row than its full width suggests.
    const l = suggestBlockSize(floorL);
    const full = suggestBlockSize(rectangleFromCorners([100, 600], [400, 900]));
    expect(l.rows).toBe(full.rows);
    expect(l.seatsPerRow).toBeLessThan(full.seatsPerRow);
    expect(l.seatsPerRow).toBeGreaterThan(0);
  });
});

describe('adding a drawn block', () => {
  it('adds the rows x seats asked for, in the outline drawn, exactly where it was drawn', () => {
    const before = arena();
    const { doc, index } = addBlock(before, drawn(floorL), stage);
    expect(index).toBe(2);
    const block = doc.sections[2];
    expect(block.name).toBe('Walk Drawn');
    expect(block.shape).toEqual(floorL);
    expect(block.rows.length).toBe(6);
    expect(block.rows.every((r) => r.kinds.length === 12)).toBe(true);
    expect(countLayoutDocument(doc).bookable).toBe(countLayoutDocument(before).bookable + 72);
    expect(block.rotationDeg).toBe(0);
    // The editor's own document is untouched: Undo is the previous document.
    expect(before.sections.length).toBe(2);
  });

  it('keeps a drawn block where it was drawn even when it covers another, and says so', () => {
    const onFront1 = rectangleFromCorners([320, 160], [420, 240]);
    expect(outlineOverlaps(arena(), onFront1, { shape: stage, label: 'STAGE' })).toEqual([
      'Front 1',
    ]);
    const { doc } = addBlock(arena(), drawn(onFront1), stage);
    expect(doc.sections[2].shape).toEqual(onFront1);
    expect(blockOverlaps(doc, 2, { shape: stage, label: 'STAGE' })).toEqual(['Front 1']);
  });

  it('refuses an outline that crosses itself, and adds nothing', () => {
    const bowTie: Pt[] = [
      [100, 600],
      [300, 800],
      [300, 600],
      [100, 800],
    ];
    expect(newBlockProblem(arena(), drawn(bowTie))).toMatch(/crosses itself/);
    const before = arena();
    expect(addBlock(before, drawn(bowTie), stage)).toEqual({ doc: before, index: -1 });
  });

  it('moves and turns like any other block afterwards', () => {
    const { doc } = addBlock(arena(), drawn(floorL), stage);
    const moved = moveBlock(doc, 2, 50, -20);
    expect((moved.sections[2].shape as Pt[])[0]).toEqual([150, 580]);
    const turned = rotateBlock(moved, 2, 15);
    expect(turned.sections[2].rotationDeg).toBe(15);
    expect((turned.sections[2].shape as Pt[]).length).toBe(6);
  });
});
