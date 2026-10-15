import { describe, expect, it } from 'vitest';
import { countLayoutDocument, type LayoutDocument } from '@eticketsgo/shared-types';
import {
  addCategory,
  addSeatsToRow,
  documentProblems,
  mergeProblem,
  mergeWithNext,
  rangeBetween,
  removeCategory,
  removeCategoryProblem,
  removeSection,
  seatName,
  setBlockSize,
  setKinds,
  setSectionCategory,
  splitSection,
  updateCategory,
} from './layout-editor';

/** A 10-row hall, 10 seats a row, one category - the owner's "planned 100". */
function hall(): LayoutDocument {
  return {
    name: 'Hall',
    categories: [
      {
        key: 'std',
        name: 'Standard',
        colorHex: '#64748B',
        priceMinor: 4999,
        priceSuggested: false,
        regulatoryClass: null,
      },
    ],
    sections: [
      {
        name: 'Hall',
        categoryKey: 'std',
        shape: null,
        labelX: null,
        labelY: null,
        tier: null,
        rotationDeg: 0,
        rows: 'ABCDEFGHIJ'.split('').map((label) => ({ label, kinds: 'SSSSSSSSSS' })),
      },
    ],
    zones: [],
  };
}

describe('seats', () => {
  it('removing a seat leaves a gap that keeps its number; restoring puts it back', () => {
    const removed = setKinds(hall(), [{ s: 0, r: 2, p: 4 }], 'GAP');
    expect(countLayoutDocument(removed).bookable).toBe(99);
    expect(seatName(removed, { s: 0, r: 2, p: 5 })).toBe('C6');
    const restored = setKinds(removed, [{ s: 0, r: 2, p: 4 }], 'SEAT');
    expect(restored.sections[0].rows[2].kinds).toBe('SSSSSSSSSS');
  });

  it('marks wheelchair, companion, restricted view and house seats, and counts them live', () => {
    let doc = hall();
    doc = setKinds(doc, [{ s: 0, r: 9, p: 0 }], 'WHEELCHAIR');
    doc = setKinds(doc, [{ s: 0, r: 9, p: 1 }], 'COMPANION');
    doc = setKinds(doc, [{ s: 0, r: 0, p: 9 }], 'RESTRICTED_VIEW');
    doc = setKinds(doc, rangeBetween(doc, { s: 0, r: 0, p: 0 }, { s: 0, r: 0, p: 1 }), 'HOUSE');
    const n = countLayoutDocument(doc);
    expect(n).toMatchObject({ accessible: 2, restricted: 1, house: 2, seats: 100, bookable: 98 });
    // The original document is untouched: every edit returns a new one.
    expect(countLayoutDocument(hall()).house).toBe(0);
  });

  it('adds seats to the end of a row, numbered on from the last', () => {
    const doc = addSeatsToRow(hall(), 0, 2, 2);
    expect(doc.sections[0].rows[2].kinds).toHaveLength(12);
    expect(seatName(doc, { s: 0, r: 2, p: 11 })).toBe('C12');
    expect(countLayoutDocument(doc).bookable).toBe(102);
  });

  it('selects a rectangle between two seats, clipped to short rows', () => {
    const doc = hall();
    doc.sections[0].rows[1] = { label: 'B', kinds: 'SSS' };
    const refs = rangeBetween(doc, { s: 0, r: 0, p: 5 }, { s: 0, r: 2, p: 2 });
    // Row A: 2..5, row B: only 2 (it has 3 seats), row C: 2..5.
    expect(refs).toHaveLength(4 + 1 + 4);
  });
});

describe('sections', () => {
  it('splits rows A-E from F-J and gives each part its own category, and merges back', () => {
    const withPremium = updateCategory(addCategory(hall()).doc, 'std', { name: 'Standard' });
    const premium = withPremium.categories[1].key;
    let doc = splitSection(withPremium, 0, 5);
    expect(doc.sections.map((s) => [s.name, s.rows.map((r) => r.label).join('')])).toEqual([
      ['Hall', 'ABCDE'],
      ['Hall F', 'FGHIJ'],
    ]);
    doc = setSectionCategory(doc, 0, premium);
    expect(doc.sections[0].categoryKey).toBe(premium);
    expect(doc.sections[1].categoryKey).toBe('std');

    expect(mergeProblem(doc, 0)).toBeNull();
    const merged = mergeWithNext(doc, 0);
    expect(merged.sections).toHaveLength(1);
    // Merging never reprices a seat: rows F-J keep Standard as their own category.
    expect(merged.sections[0].categoryKey).toBe(premium);
    expect(merged.sections[0].rows[5].categoryKey).toBe('std');
  });

  it('will not merge two sections that both have a row A', () => {
    const doc = hall();
    doc.sections.push({ ...doc.sections[0], name: 'Balcony' });
    expect(mergeProblem(doc, 0)).toBe(
      'Both sections have a row A, so one row would hide the other.',
    );
    expect(mergeWithNext(doc, 0)).toBe(doc);
  });

  it('sizes a block: rows at the back, the same width change on every row', () => {
    const wedge = hall();
    wedge.sections[0].rows = [
      { label: 'A', kinds: 'SSSS' },
      { label: 'B', kinds: 'SSSSS' },
    ];
    // Four rows, front row 6: a wedge stays a wedge (6, 7, 8, 9).
    const doc = setBlockSize(wedge, 0, 4, 6);
    expect(doc.sections[0].rows.map((r) => r.kinds.length)).toEqual([6, 7, 8, 9]);
    expect(doc.sections[0].rows.map((r) => r.label).join('')).toBe('ABCD');
    // And back down: two rows of three in front.
    const smaller = setBlockSize(doc, 0, 2, 3);
    expect(smaller.sections[0].rows.map((r) => r.kinds.length)).toEqual([3, 4]);
  });

  it('removes a block, but never the last one', () => {
    const doc = hall();
    doc.sections.push({ ...doc.sections[0], name: 'Rear 5' });
    expect(removeSection(doc, 1).sections.map((s) => s.name)).toEqual(['Hall']);
    expect(removeSection(hall(), 0).sections).toHaveLength(1);
  });
});

describe('categories', () => {
  it('adds one, refuses to remove one that seats use, removes an unused one', () => {
    const { doc, key } = addCategory(hall());
    expect(doc.categories).toHaveLength(2);
    expect(removeCategoryProblem(doc, 'std')).toBe(
      'Used by 1 section. Give it another category first.',
    );
    expect(removeCategory(doc, 'std')).toBe(doc);
    expect(removeCategory(doc, key).categories.map((c) => c.key)).toEqual(['std']);
  });

  it('says what blocks a save in plain words', () => {
    const { doc, key } = addCategory(hall());
    expect(documentProblems(doc, { [key]: '' })).toEqual(['Enter a price for New category.']);
    const twin = updateCategory(doc, key, { name: 'standard' });
    expect(documentProblems(twin, { [key]: '10' })).toEqual([
      'Two ticket categories are called "standard".',
    ]);
  });
});
