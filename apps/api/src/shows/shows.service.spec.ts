import { ShowsService } from './shows.service';

/**
 * The seat view, or a failure that says so.
 *
 * `getPublicSeatLayout` returns a discriminated union — an overview for a sectioned venue,
 * seats for everything else — so a test that wants rows has to say which it expected. That
 * is the point of the discriminant: reaching for `rows` on an overview is a compile error
 * rather than an empty grid telling a customer the block is sold out.
 */
function expectSeatView<T extends { view: string }>(layout: T): Extract<T, { view: 'seats' }> {
  if (layout.view !== 'seats') {
    throw new Error(`expected a seat view, got "${layout.view}"`);
  }
  return layout as Extract<T, { view: 'seats' }>;
}

describe('ShowsService.getPublicSeatLayout', () => {
  const seatMap = {
    categories: [
      { id: 'cat1', name: 'Normal', colorHex: '#38bdf8', basePriceMinor: 20_000, sortOrder: 0 },
      { id: 'cat2', name: 'Premium', colorHex: '#a78bfa', basePriceMinor: 30_000, sortOrder: 1 },
    ],
    sections: [
      {
        name: 'Normal',
        sortOrder: 0,
        rows: [
          {
            label: 'A',
            sortOrder: 0,
            seats: [
              { id: 's1', label: '1', colIndex: 1, seatCategoryId: 'cat1' },
              { id: 's2', label: '2', colIndex: 2, seatCategoryId: 'cat1' },
            ],
          },
        ],
      },
    ],
  };

  function makeService(session: unknown) {
    const prisma = {
      eventSession: { findUnique: jest.fn().mockResolvedValue(session) },
    };
    const service = new ShowsService(prisma as never, {} as never);
    return { service, prisma };
  }

  it('maps ShowSeat status onto each seat and prices categories from the session ticket type', async () => {
    const { service } = makeService({
      id: 'sess1',
      seatMap,
      ticketTypes: [
        { id: 'tt1', seatCategoryId: 'cat1', priceMinor: 25_000 },
        { id: 'tt2', seatCategoryId: 'cat2', priceMinor: 32_000 },
      ],
      showSeats: [
        { seatId: 's1', status: 'SOLD' },
        { seatId: 's2', status: 'HELD' },
      ],
    });

    const layout = await service.getPublicSeatLayout('sess1');

    expect(layout.sessionId).toBe('sess1');
    // Category price comes from the session's TicketType, not basePriceMinor.
    expect(layout.categories[0]).toEqual({
      id: 'cat1',
      ticketTypeId: 'tt1',
      name: 'Normal',
      colorHex: '#38bdf8',
      priceMinor: 25_000,
    });

    const seats = expectSeatView(layout).sections[0].rows[0].seats;
    expect(seats.map((s) => s.status)).toEqual(['SOLD', 'HELD']);
    expect(seats.every((s) => s.categoryId === 'cat1')).toBe(true);
  });

  it('defaults a seat with no ShowSeat row to AVAILABLE', async () => {
    const { service } = makeService({
      id: 'sess1',
      seatMap,
      ticketTypes: [{ id: 'tt1', seatCategoryId: 'cat1', priceMinor: 25_000 }],
      showSeats: [{ seatId: 's1', status: 'SOLD' }],
    });

    const layout = await service.getPublicSeatLayout('sess1');
    const seats = expectSeatView(layout).sections[0].rows[0].seats;
    expect(seats.map((s) => s.status)).toEqual(['SOLD', 'AVAILABLE']);
  });

  it('renders the layout PINNED TO THE SHOW, not the screen’s current one', async () => {
    /*
      The regression versioning exists to prevent. A screen that has since been re-seated
      still has to show the old room to a show that was sold from it — otherwise a customer
      sees seats that no longer exist and prices from a tier the show never had.

      The screen here carries a completely different (newer) layout. If the service ever
      reaches for it again, the section name and seat ids below stop matching.
    */
    const newerLayoutOnTheScreen = {
      categories: [
        { id: 'catX', name: 'Recliner', colorHex: '#f00', basePriceMinor: 90_000, sortOrder: 0 },
      ],
      sections: [
        {
          name: 'Re-seated stalls',
          sortOrder: 0,
          rows: [
            {
              label: 'A',
              sortOrder: 0,
              seats: [{ id: 'sX', label: '1', colIndex: 1, seatCategoryId: 'catX' }],
            },
          ],
        },
      ],
    };

    const { service } = makeService({
      id: 'sess1',
      seatMap,
      screen: { seatMap: newerLayoutOnTheScreen },
      ticketTypes: [{ id: 'tt1', seatCategoryId: 'cat1', priceMinor: 25_000 }],
      showSeats: [{ seatId: 's1', status: 'SOLD' }],
    });

    const layout = await service.getPublicSeatLayout('sess1');
    const seatView = expectSeatView(layout);
    expect(seatView.sections[0].name).toBe('Normal');
    expect(seatView.sections[0].rows[0].seats.map((s) => s.id)).toEqual(['s1', 's2']);
    // The pinned layout's own categories — emphatically not the screen's newer 'catX'.
    expect(layout.categories.map((c) => c.id)).toEqual(['cat1', 'cat2']);
  });

  it('throws NOT_FOUND when the session or its seat map is missing', async () => {
    const { service } = makeService(null);
    await expect(service.getPublicSeatLayout('missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
