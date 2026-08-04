import {
  findSeatConflicts,
  flattenSeats,
  maxSelectableSeats,
  selectionTotalMinor,
  toBookingItems,
} from '../api';
import { isSelectable, seatMapSchema, seatVisualState, type SeatMap } from '../schema';

/**
 * Fixture modelled on the real QA response for session cmsdp3od100758jznrl6atlru
 * (GET /public/shows/:sessionId/seats, 2026-08-04), shrunk to two rows per category.
 */
function makeMap(overrides: Partial<SeatMap> = {}): SeatMap {
  return seatMapSchema.parse({
    sessionId: 'sess_1',
    categories: [
      {
        id: 'cat_normal',
        ticketTypeId: 'tt_normal',
        name: 'Normal',
        colorHex: '#38bdf8',
        priceMinor: 20000,
      },
      {
        id: 'cat_premium',
        ticketTypeId: 'tt_premium',
        name: 'Premium',
        colorHex: '#a78bfa',
        priceMinor: 30000,
      },
      // A category with NO ticket type mapped — the server really can return this.
      { id: 'cat_orphan', ticketTypeId: null, name: 'Box', colorHex: null, priceMinor: 99900 },
    ],
    sections: [
      {
        name: 'Normal',
        rows: [
          {
            label: 'A',
            seats: [
              {
                id: 's_a1',
                label: '1',
                colIndex: 1,
                categoryId: 'cat_normal',
                status: 'AVAILABLE',
              },
              { id: 's_a2', label: '2', colIndex: 2, categoryId: 'cat_normal', status: 'SOLD' },
              { id: 's_a3', label: '3', colIndex: 3, categoryId: 'cat_normal', status: 'HELD' },
              // colIndex jumps 3 → 5: an aisle. Layout must not close the gap.
              {
                id: 's_a5',
                label: '5',
                colIndex: 5,
                categoryId: 'cat_normal',
                status: 'AVAILABLE',
              },
            ],
          },
        ],
      },
      {
        name: 'Premium',
        rows: [
          {
            label: 'B',
            seats: [
              {
                id: 's_b1',
                label: '1',
                colIndex: 1,
                categoryId: 'cat_premium',
                status: 'AVAILABLE',
              },
              {
                id: 's_b2',
                label: '2',
                colIndex: 2,
                categoryId: 'cat_orphan',
                status: 'AVAILABLE',
              },
            ],
          },
        ],
      },
    ],
    ...overrides,
  });
}

const cat = (map: SeatMap, id: string) => map.categories.find((c) => c.id === id);

describe('seat selectability', () => {
  const map = makeMap();
  const seats = Object.fromEntries(flattenSeats(map).map((s) => [s.seat.id, s.seat]));

  it('allows only AVAILABLE seats in a category that has a ticket type', () => {
    expect(isSelectable(seats.s_a1, cat(map, 'cat_normal'))).toBe(true);
    expect(isSelectable(seats.s_a2, cat(map, 'cat_normal'))).toBe(false); // SOLD
    expect(isSelectable(seats.s_a3, cat(map, 'cat_normal'))).toBe(false); // HELD
  });

  it('refuses an AVAILABLE seat whose category has no ticket type', () => {
    // Bookable-looking but unbookable: a line needs a ticketTypeId, so letting this be
    // picked would build a booking the API must reject.
    expect(seats.s_b2.status).toBe('AVAILABLE');
    expect(isSelectable(seats.s_b2, cat(map, 'cat_orphan'))).toBe(false);
  });

  it('treats an unrecognised server status as unavailable, not as available', () => {
    // Fail closed. A new backend state must never become a bookable seat by default.
    const future = { ...seats.s_a1, status: 'RESERVED_FOR_ACCESSIBILITY' };
    expect(isSelectable(future, cat(map, 'cat_normal'))).toBe(false);
    expect(seatVisualState(future, cat(map, 'cat_normal'), false)).toBe('unavailable');
  });

  it('never lets local selection mask a server state', () => {
    // Even if this device believes the seat is selected, SOLD from the server wins.
    expect(seatVisualState(seats.s_a2, cat(map, 'cat_normal'), true)).toBe('sold');
    expect(seatVisualState(seats.s_a3, cat(map, 'cat_normal'), true)).toBe('held');
    expect(seatVisualState(seats.s_a1, cat(map, 'cat_normal'), true)).toBe('selected');
  });
});

describe('booking lines from a seat selection', () => {
  const map = makeMap();

  it('groups seats by ticket type with quantity matching seatIds length', () => {
    const items = toBookingItems(map, ['s_a1', 's_a5', 's_b1']);

    expect(items).toHaveLength(2);
    const normal = items.find((i) => i.ticketTypeId === 'tt_normal');
    const premium = items.find((i) => i.ticketTypeId === 'tt_premium');

    // createBookingSchema refines on exactly this equality.
    for (const line of items) expect(line.quantity).toBe(line.seatIds.length);
    expect(normal?.seatIds.sort()).toEqual(['s_a1', 's_a5']);
    expect(premium?.seatIds).toEqual(['s_b1']);
  });

  it('drops a seat whose category has no ticket type rather than emitting a null line', () => {
    const items = toBookingItems(map, ['s_a1', 's_b2']);

    expect(items).toHaveLength(1);
    expect(items[0].ticketTypeId).toBe('tt_normal');
    expect(items[0].seatIds).toEqual(['s_a1']);
  });

  it('totals a mixed selection from the server’s per-category prices', () => {
    // 2 Normal @20000 + 1 Premium @30000 = 70000 minor units.
    expect(selectionTotalMinor(map, ['s_a1', 's_a5', 's_b1'])).toBe(70000);
    expect(selectionTotalMinor(map, [])).toBe(0);
  });
});

describe('revalidation before checkout', () => {
  const original = makeMap();

  it('passes when every selected seat is still available', () => {
    expect(findSeatConflicts(original, ['s_a1', 's_a5'])).toEqual([]);
  });

  it('names the seats that were taken while the user was choosing', () => {
    const fresh = makeMap();
    fresh.sections[0].rows[0].seats[0].status = 'SOLD'; // s_a1 gone

    const conflicts = findSeatConflicts(fresh, ['s_a1', 's_a5']);

    expect(conflicts).toHaveLength(1);
    // The name is what the user sees in the alert — "A1", not a cuid.
    expect(conflicts[0]).toMatchObject({ seatId: 's_a1', name: 'A1', status: 'SOLD' });
  });

  it('reports a seat that has vanished from the map entirely', () => {
    const fresh = makeMap();
    fresh.sections[0].rows[0].seats = fresh.sections[0].rows[0].seats.filter(
      (s) => s.id !== 's_a5',
    );

    const conflicts = findSeatConflicts(fresh, ['s_a5']);

    // Silently dropping it would send a smaller booking than the user agreed to.
    expect(conflicts).toEqual([{ seatId: 's_a5', name: 'A selected seat', status: 'REMOVED' }]);
  });

  it('catches a seat that became HELD by someone else mid-selection', () => {
    const fresh = makeMap();
    fresh.sections[1].rows[0].seats[0].status = 'HELD';

    expect(findSeatConflicts(fresh, ['s_b1'])).toMatchObject([{ name: 'B1', status: 'HELD' }]);
  });
});

describe('per-order seat cap', () => {
  it('uses the smallest maxPerOrder across the session’s ticket types', () => {
    // A mixed selection could land anywhere across categories, so the cap is the
    // tightest one — the API enforces per ticket type.
    expect(maxSelectableSeats([10, 4, 8])).toBe(4);
  });

  it('falls back to 10 when no ticket types are known yet', () => {
    expect(maxSelectableSeats([])).toBe(10);
  });

  it('never returns zero, which would make the screen unusable', () => {
    expect(maxSelectableSeats([0])).toBe(1);
  });
});

describe('seat map contract', () => {
  it('accepts a null colorHex and a null ticketTypeId', () => {
    expect(() => makeMap()).not.toThrow();
  });

  it('preserves colIndex holes so aisles stay aisles', () => {
    const row = makeMap().sections[0].rows[0];
    expect(row.seats.map((s) => s.colIndex)).toEqual([1, 2, 3, 5]);
  });

  it('rejects a response missing seat status', () => {
    expect(() =>
      seatMapSchema.parse({
        sessionId: 'x',
        categories: [],
        sections: [
          {
            name: 'A',
            rows: [{ label: 'A', seats: [{ id: '1', label: '1', colIndex: 1, categoryId: 'c' }] }],
          },
        ],
      }),
    ).toThrow();
  });
});
