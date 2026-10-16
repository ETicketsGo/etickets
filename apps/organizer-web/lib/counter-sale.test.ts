import { describe, expect, it } from 'vitest';
import type { SeatLayout } from '@eticketsgo/web-kit';
import { bestSeats, cartSubtotal, maxFor, ticketCount, type CounterShow } from './counter-sale';

const seat = (id: string, col: number, over: Record<string, unknown> = {}) => ({
  id,
  // The API's seat label is the seat alone; the row is on the row.
  label: id.slice(1),
  colIndex: col,
  categoryId: 'gold',
  kind: 'SEAT' as const,
  status: 'AVAILABLE' as const,
  ...over,
});

const layout = (rows: { label: string; seats: ReturnType<typeof seat>[] }[]): SeatLayout =>
  ({
    view: 'seats',
    sections: [{ id: 's', name: 'Main', shape: null, tier: null, rotationDeg: 0, rows }],
  }) as unknown as SeatLayout;

describe('seats for a walk-up buyer', () => {
  it('gives seats side by side in the first row that has them', () => {
    const map = layout([
      { label: 'A', seats: [seat('A1', 1), seat('A2', 2, { status: 'SOLD' }), seat('A3', 3)] },
      { label: 'B', seats: [seat('B1', 1), seat('B2', 2), seat('B3', 3)] },
    ]);
    expect(bestSeats(map, 'gold', 2)?.labels).toEqual(['B1', 'B2']);
    expect(bestSeats(map, 'gold', 1)?.labels).toEqual(['A1']);
  });

  it('never splits a group across an aisle or into another category', () => {
    const map = layout([
      {
        label: 'A',
        seats: [seat('A1', 1), seat('A3', 3), seat('A4', 4, { categoryId: 'silver' })],
      },
    ]);
    expect(bestSeats(map, 'gold', 2)).toBeNull();
  });

  it('leaves wheelchair spaces and companion seats for the people they exist for', () => {
    const map = layout([
      { label: 'A', seats: [seat('A1', 1, { kind: 'WHEELCHAIR' }), seat('A2', 2), seat('A3', 3)] },
    ]);
    expect(bestSeats(map, 'gold', 3)).toBeNull();
    expect(bestSeats(map, 'gold', 2)?.labels).toEqual(['A2', 'A3']);
  });

  it('does not give the same seat to two lines of one sale', () => {
    const map = layout([{ label: 'A', seats: [seat('A1', 1), seat('A2', 2), seat('A3', 3)] }]);
    expect(bestSeats(map, 'gold', 2, new Set(['A1']))?.labels).toEqual(['A2', 'A3']);
  });
});

describe('the counter cart', () => {
  const show = {
    ticketTypes: [
      { id: 'a', priceMinor: 50_000, maxPerOrder: 10, left: 3 },
      { id: 'b', priceMinor: 20_000, maxPerOrder: 4, left: null },
    ],
  } as unknown as CounterShow;

  it('adds up face value and counts tickets', () => {
    expect(cartSubtotal(show, { a: 2, b: 1 })).toBe(120_000);
    expect(ticketCount({ a: 2, b: 1, c: 0 })).toBe(3);
  });

  it('caps a line at what is left, or at the per-order limit', () => {
    expect(maxFor(show.ticketTypes[0])).toBe(3);
    expect(maxFor(show.ticketTypes[1])).toBe(4);
  });
});
