import { describe, expect, it } from 'vitest';
import {
  expandRowLabels,
  expandSeatPositions,
  previewSection,
  seatKindsFor,
  type SectionDraft,
} from './seat-layout';

/**
 * Turning what an operator types into a room.
 *
 * The reported problem was that a 250-seat auditorium was impractical to describe: twenty
 * row labels typed by hand, no way to say which seats are a wheelchair bay, and no way to
 * tell whether the two numbers you entered add up to the house you meant.
 */
const draft = (over: Partial<SectionDraft> = {}): SectionDraft => ({
  name: 'Stalls',
  categoryName: 'Standard',
  colorHex: '#2563EB',
  basePrice: '150',
  rowLabels: 'A-D',
  seatsPerRow: '10',
  wheelchairSeats: '',
  companionSeats: '',
  gapSeats: '',
  ...over,
});

describe('expandRowLabels', () => {
  it('expands a range, which is the whole point for a real auditorium', () => {
    // Twenty rows from two characters, instead of "A,B,C,...,T" typed by hand.
    expect(expandRowLabels('A-T')).toHaveLength(20);
    expect(expandRowLabels('A-D')).toEqual(['A', 'B', 'C', 'D']);
  });

  it('still accepts a plain list, and a mixture of both', () => {
    expect(expandRowLabels('A, B, C')).toEqual(['A', 'B', 'C']);
    expect(expandRowLabels('A-C, AA, BB')).toEqual(['A', 'B', 'C', 'AA', 'BB']);
  });

  it('is case-insensitive and ignores stray whitespace', () => {
    expect(expandRowLabels(' a - c ')).toEqual(['A', 'B', 'C']);
  });

  it('de-duplicates, because two rows with one label is a database error', () => {
    // The (row, label) unique index would reject it, failing the whole generation with a
    // constraint violation instead of anything an operator could act on.
    expect(expandRowLabels('A-C, B')).toEqual(['A', 'B', 'C']);
  });

  it('ignores a descending range rather than reversing the room', () => {
    expect(expandRowLabels('T-A')).toEqual([]);
  });

  it('returns nothing for empty or meaningless input', () => {
    expect(expandRowLabels('')).toEqual([]);
    expect(expandRowLabels(' , , ')).toEqual([]);
  });
});

describe('expandSeatPositions', () => {
  it('expands ranges and single numbers together, in order', () => {
    expect(expandSeatPositions('19, 1-4, 20', 20)).toEqual([1, 2, 3, 4, 19, 20]);
  });

  it('drops positions the row does not have', () => {
    // An operator narrowing a row from 20 seats to 12 should not be blocked by a marker
    // they set earlier and can no longer see.
    expect(expandSeatPositions('1, 2, 19, 20', 12)).toEqual([1, 2]);
  });

  it('ignores zero, negatives and nonsense', () => {
    expect(expandSeatPositions('0, -3, abc, 5', 10)).toEqual([5]);
  });
});

describe('previewSection', () => {
  it('counts the room so the operator can check it against what they meant', () => {
    const p = previewSection(draft({ rowLabels: 'A-T', seatsPerRow: '20' }));
    expect(p.rows).toHaveLength(20);
    expect(p.total).toBe(400);
    expect(p.sellable).toBe(400);
  });

  it('marks wheelchair spaces in every row of the section', () => {
    // One input describes twenty rows, because an accessible bay runs down the same side of
    // a block — twenty inputs would be the same unusable shape as typing row labels by hand.
    const p = previewSection(draft({ rowLabels: 'A-D', wheelchairSeats: '1-2' }));
    expect(p.wheelchair).toBe(8);
    expect(p.rows[0].seats.slice(0, 2).map((s) => s.kind)).toEqual(['WHEELCHAIR', 'WHEELCHAIR']);
    expect(p.rows[3].seats[0].kind).toBe('WHEELCHAIR');
  });

  it('excludes aisle gaps from what can be sold', () => {
    const p = previewSection(draft({ rowLabels: 'A-B', seatsPerRow: '10', gapSeats: '5,6' }));
    expect(p.total).toBe(20);
    expect(p.gaps).toBe(4);
    expect(p.sellable).toBe(16);
  });

  it('resolves a position claimed twice by a fixed precedence, not by input order', () => {
    // Without an order, listing 1 as both a gap and a wheelchair space would resolve
    // differently depending on which field was filled first.
    const p = previewSection(draft({ wheelchairSeats: '1', gapSeats: '1', companionSeats: '1' }));
    expect(p.rows[0].seats[0].kind).toBe('GAP');
    const q = previewSection(draft({ wheelchairSeats: '2', companionSeats: '2' }));
    expect(q.rows[0].seats[1].kind).toBe('WHEELCHAIR');
  });

  it('produces nothing rather than throwing on a half-filled form', () => {
    // The preview renders on every keystroke, including while the operator is mid-word.
    expect(previewSection(draft({ seatsPerRow: '' })).total).toBe(0);
    expect(previewSection(draft({ rowLabels: '' })).rows).toEqual([]);
    expect(previewSection(draft({ seatsPerRow: 'abc' })).total).toBe(0);
  });
});

describe('seatKindsFor', () => {
  it('emits one entry per row and kind, in the shape the API accepts', () => {
    const out = seatKindsFor(
      draft({ rowLabels: 'A-B', wheelchairSeats: '1', companionSeats: '2' }),
    );
    expect(out).toEqual([
      { rowLabel: 'A', seats: [1], kind: 'WHEELCHAIR' },
      { rowLabel: 'A', seats: [2], kind: 'COMPANION' },
      { rowLabel: 'B', seats: [1], kind: 'WHEELCHAIR' },
      { rowLabel: 'B', seats: [2], kind: 'COMPANION' },
    ]);
  });

  it('says nothing at all when the section is ordinary seats', () => {
    // An all-SEAT room must not send hundreds of redundant overrides.
    expect(seatKindsFor(draft({ rowLabels: 'A-T', seatsPerRow: '20' }))).toEqual([]);
  });

  it('agrees with the preview, because both come from the same function', () => {
    const d = draft({ rowLabels: 'A-C', seatsPerRow: '12', wheelchairSeats: '1-2', gapSeats: '7' });
    const preview = previewSection(d);
    const emitted = seatKindsFor(d);
    const wheelchairs = emitted
      .filter((e) => e.kind === 'WHEELCHAIR')
      .reduce((n, e) => n + e.seats.length, 0);
    const gaps = emitted.filter((e) => e.kind === 'GAP').reduce((n, e) => n + e.seats.length, 0);
    expect(wheelchairs).toBe(preview.wheelchair);
    expect(gaps).toBe(preview.gaps);
  });
});
