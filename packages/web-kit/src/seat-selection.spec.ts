import { describe, expect, it } from 'vitest';
import {
  applySeatTap,
  pickAdjacentSeats,
  seatGroupName,
  seatInDirection,
  strandedSeats,
  type SelectableSeat,
} from './seat-selection';

/** A row from a compact picture: `.` available, `x` sold, `_` aisle, `w` wheelchair, `c` companion, `P` premium. */
function row(picture: string, prefix = 'A'): SelectableSeat[] {
  const seats: SelectableSeat[] = [];
  let col = 0;
  for (const ch of picture) {
    col += 1;
    if (ch === '_') continue;
    seats.push({
      id: `${prefix}${col}`,
      colIndex: col,
      categoryId: ch === 'P' ? 'premium' : 'normal',
      status: ch === 'x' ? 'SOLD' : 'AVAILABLE',
      kind: ch === 'w' ? 'WHEELCHAIR' : ch === 'c' ? 'COMPANION' : 'SEAT',
    });
  }
  return seats;
}

describe('pickAdjacentSeats — the quick pick', () => {
  it('takes the tapped seat and the seats to its right', () => {
    expect(pickAdjacentSeats(row('......'), 'A2', 3)).toEqual(['A2', 'A3', 'A4']);
  });

  it('fills to the left when the right runs out', () => {
    expect(pickAdjacentSeats(row('....x.'), 'A4', 3)).toEqual(['A2', 'A3', 'A4']);
  });

  it('never crosses an aisle, a price or a sold seat', () => {
    expect(pickAdjacentSeats(row('.._..'), 'A2', 3)).toEqual(['A1', 'A2']);
    expect(pickAdjacentSeats(row('..PP'), 'A2', 3)).toEqual(['A1', 'A2']);
    expect(pickAdjacentSeats(row('.x..'), 'A3', 3)).toEqual(['A3', 'A4']);
  });

  it('never spreads an ordinary group onto a wheelchair space or companion seat', () => {
    expect(pickAdjacentSeats(row('..wc'), 'A2', 4)).toEqual(['A1', 'A2']);
  });

  it('lets a wheelchair user take the companion seat beside them', () => {
    expect(pickAdjacentSeats(row('..wc'), 'A3', 2)).toEqual(['A3', 'A4']);
  });

  it('takes nothing when the tapped seat cannot be sold', () => {
    expect(pickAdjacentSeats(row('.x.'), 'A2', 2)).toEqual([]);
  });
});

describe('applySeatTap', () => {
  const r = row('........');

  it('toggles one seat at a time when no ticket count was chosen', () => {
    const first = applySeatTap({ selected: [], row: r, seatId: 'A3', quantity: null });
    expect(first.selected).toEqual(['A3']);
    const second = applySeatTap({ selected: first.selected, row: r, seatId: 'A6', quantity: null });
    expect(second.selected).toEqual(['A3', 'A6']);
  });

  it('fills the chosen count from the tapped seat', () => {
    expect(applySeatTap({ selected: [], row: r, seatId: 'A3', quantity: 2 }).selected).toEqual([
      'A3',
      'A4',
    ]);
  });

  it('places the whole group again once the count is met', () => {
    expect(
      applySeatTap({ selected: ['A1', 'A2'], row: r, seatId: 'A6', quantity: 2 }).selected,
    ).toEqual(['A6', 'A7']);
  });

  it('adds only what is still missing when part of the group is chosen', () => {
    // Three tickets, one seat already taken elsewhere: this tap supplies the other two.
    expect(applySeatTap({ selected: ['A1'], row: r, seatId: 'A5', quantity: 3 }).selected).toEqual([
      'A1',
      'A5',
      'A6',
    ]);
  });

  it('releases a chosen seat, whatever the count', () => {
    expect(
      applySeatTap({ selected: ['A3', 'A4'], row: r, seatId: 'A4', quantity: 2 }).selected,
    ).toEqual(['A3']);
  });

  it('refuses a tenth-plus-one seat and says so', () => {
    const ten = Array.from({ length: 10 }, (_, i) => `B${i}`);
    expect(applySeatTap({ selected: ten, row: r, seatId: 'A1', quantity: null })).toEqual({
      selected: ten,
      limitReached: true,
    });
  });

  it('ignores a tap on a seat that is sold', () => {
    expect(
      applySeatTap({ selected: [], row: row('.x.'), seatId: 'A2', quantity: null }).selected,
    ).toEqual([]);
  });
});

describe('strandedSeats', () => {
  it('flags one seat left between the selection and a sold seat', () => {
    expect(strandedSeats(row('...x'), new Set(['A1', 'A2']))).toEqual(['A3']);
  });

  it('flags one seat left at the end of the row', () => {
    expect(strandedSeats(row('....'), new Set(['A2', 'A3']))).toEqual(['A1', 'A4']);
  });

  it('does not flag a seat that still has a sellable neighbour', () => {
    expect(strandedSeats(row('.....'), new Set(['A1', 'A2']))).toEqual([]);
  });

  it('does not blame the buyer for gaps they did not make', () => {
    // A3 was already stranded between two sold seats before anyone chose anything.
    expect(strandedSeats(row('.x.x..'), new Set(['A5', 'A6']))).toEqual([]);
  });
});

describe('seatGroupName — what the basket calls the seats', () => {
  it('names the block the buyer saw on the map, and adds the category when it differs', () => {
    // Reported by the owner: seats under "BALCONY" were listed as "Premium".
    expect(seatGroupName(['BALCONY'], 'Premium')).toEqual({
      title: 'BALCONY',
      category: 'Premium',
    });
  });

  it('says one name once when the cinema named both the same', () => {
    expect(seatGroupName(['NORMAL'], 'Normal')).toEqual({ title: 'NORMAL', category: null });
  });

  it('lists each block once when the seats span blocks at one price', () => {
    expect(seatGroupName(['Stalls', 'Balcony', 'stalls'], 'Premium')).toEqual({
      title: 'Stalls, Balcony',
      category: 'Premium',
    });
  });

  it('falls back to the category when no block name is known', () => {
    expect(seatGroupName([''], 'Premium')).toEqual({ title: 'Premium', category: null });
  });
});

describe('seatInDirection — arrow keys', () => {
  const rows = [{ seats: row('....', 'A') }, { seats: [] }, { seats: row('_..._', 'C') }];

  it('steps along the row and stops at its ends', () => {
    expect(seatInDirection(rows, { rowIndex: 0, seatId: 'A2' }, 'right')).toEqual({
      rowIndex: 0,
      seatId: 'A3',
    });
    expect(seatInDirection(rows, { rowIndex: 0, seatId: 'A1' }, 'left')).toBeNull();
  });

  it('skips an empty row and lands on the nearest seat of the next', () => {
    expect(seatInDirection(rows, { rowIndex: 0, seatId: 'A1' }, 'down')).toEqual({
      rowIndex: 2,
      seatId: 'C2',
    });
    expect(seatInDirection(rows, { rowIndex: 2, seatId: 'C4' }, 'up')).toEqual({
      rowIndex: 0,
      seatId: 'A4',
    });
  });

  it('stops at the first and last rows', () => {
    expect(seatInDirection(rows, { rowIndex: 0, seatId: 'A1' }, 'up')).toBeNull();
    expect(seatInDirection(rows, { rowIndex: 2, seatId: 'C2' }, 'down')).toBeNull();
  });
});
