import { describe, expect, it } from 'vitest';
import { countSeatKinds, reconcileSeats } from './seat-reconciliation';

describe('reconcileSeats', () => {
  it('never counts an aisle as bookable', () => {
    const r = reconcileSeats([
      { kind: 'SEAT', count: 144 },
      { kind: 'GAP', count: 9 },
    ]);
    expect(r).toMatchObject({ positions: 153, aisles: 9, bookable: 144, blocked: 0 });
  });

  it('counts accessible places as bookable, and reports them', () => {
    const r = reconcileSeats([
      { kind: 'SEAT', count: 10 },
      { kind: 'WHEELCHAIR', count: 2 },
      { kind: 'COMPANION', count: 2 },
      { kind: 'GAP', count: 1 },
    ]);
    expect(r).toMatchObject({ wheelchair: 2, companion: 2, accessible: 4, bookable: 14 });
  });

  it('takes blocked seats out of what a session can sell', () => {
    const r = reconcileSeats([{ kind: 'SEAT', count: 10 }], { blocked: 3 });
    expect(r.bookable).toBe(7);
    expect(r.blocked).toBe(3);
  });

  it('cannot go below zero, whatever it is told about blocked seats', () => {
    const r = reconcileSeats(
      [
        { kind: 'SEAT', count: 2 },
        { kind: 'GAP', count: 5 },
      ],
      { blocked: 40 },
    );
    expect(r).toMatchObject({ blocked: 2, bookable: 0 });
  });

  it('sells a kind it does not recognise, as the API does', () => {
    expect(reconcileSeats([{ kind: 'BOX', count: 4 }]).bookable).toBe(4);
  });
});

describe('countSeatKinds', () => {
  it('agrees with reconcileSeats when fed the seats themselves', () => {
    const seats = [{ kind: 'SEAT' }, { kind: 'GAP' }, { kind: 'SEAT' }, { kind: 'WHEELCHAIR' }];
    expect(reconcileSeats(countSeatKinds(seats))).toMatchObject({
      positions: 4,
      aisles: 1,
      accessible: 1,
      bookable: 3,
    });
  });
});
