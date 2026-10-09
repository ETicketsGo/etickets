import { describe, expect, it } from 'vitest';
import type { LayoutTemplateOutline } from '@eticketsgo/web-kit';
import { draftsFromOutline, templateBookable } from './layout-gallery';
import { capacitySummary, seatKindsFor } from './seat-layout';

/*
  The FLAT_HALL template as the API describes it: ten rows of twelve seats with an aisle at
  position 7 in every row, and a wheelchair bay (1) with its companion (2) in the BACK row only.
*/
const rows = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
const hall: LayoutTemplateOutline = {
  key: 'FLAT_HALL',
  label: 'Flat hall',
  description: '',
  layoutKind: 'GRID',
  focal: { kind: 'STAGE_END', label: 'STAGE', shape: [] },
  categories: [{ name: 'Standard', colorHex: '#64748B', priceWeight: 1 }],
  sections: [
    {
      name: 'Hall',
      categoryName: 'Standard',
      tier: 'FLOOR',
      shape: [],
      rowLabels: rows,
      positions: 13,
      seatKinds: [
        ...rows.map((rowLabel) => ({ rowLabel, seats: [7], kind: 'GAP' as const })),
        { rowLabel: 'J', seats: [1], kind: 'WHEELCHAIR' },
        { rowLabel: 'J', seats: [2], kind: 'COMPANION' },
      ],
    },
  ],
  kindCounts: [
    { kind: 'SEAT', count: 118 },
    { kind: 'GAP', count: 10 },
    { kind: 'WHEELCHAIR', count: 1 },
    { kind: 'COMPANION', count: 1 },
  ],
};

describe('draftsFromOutline', () => {
  it('fills the generator with the room the card promised', () => {
    const drafts = draftsFromOutline(hall, '200');
    const summary = capacitySummary(drafts, [null]);
    // The card's number and the generator's number are the same number.
    expect(summary.bookable).toBe(templateBookable(hall));
    expect(summary.bookable).toBe(120);
    expect(summary.aisles).toBe(10);
    // ONE wheelchair space and ONE companion seat, not one per row.
    expect(summary.accessible).toBe(2);
  });

  it('sends the API the same aisle and accessible positions the template has', () => {
    const [draft] = draftsFromOutline(hall, '200');
    const kinds = seatKindsFor(draft);
    expect(kinds.filter((k) => k.kind === 'GAP')).toHaveLength(10);
    expect(kinds.filter((k) => k.kind === 'WHEELCHAIR')).toEqual([
      { rowLabel: 'J', seats: [1], kind: 'WHEELCHAIR' },
    ]);
  });

  it('prices each section from the base by its category weight', () => {
    const two: LayoutTemplateOutline = {
      ...hall,
      categories: [
        { name: 'Stalls', colorHex: '#DC2626', priceWeight: 1.4 },
        { name: 'Balcony', colorHex: '#0891B2', priceWeight: 1 },
      ],
      sections: [
        { ...hall.sections[0], name: 'Stalls', categoryName: 'Stalls' },
        { ...hall.sections[0], name: 'Balcony', categoryName: 'Balcony' },
      ],
    };
    const [stalls, balcony] = draftsFromOutline(two, '500');
    expect(stalls.basePrice).toBe('700');
    expect(balcony.basePrice).toBe('500');
    expect(stalls.colorHex).toBe('#DC2626');
  });
});
