import { ShowsService } from './shows.service';

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
      screen: { seatMap },
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

    const seats = layout.sections[0].rows[0].seats;
    expect(seats.map((s) => s.status)).toEqual(['SOLD', 'HELD']);
    expect(seats.every((s) => s.categoryId === 'cat1')).toBe(true);
  });

  it('defaults a seat with no ShowSeat row to AVAILABLE', async () => {
    const { service } = makeService({
      id: 'sess1',
      screen: { seatMap },
      ticketTypes: [{ id: 'tt1', seatCategoryId: 'cat1', priceMinor: 25_000 }],
      showSeats: [{ seatId: 's1', status: 'SOLD' }],
    });

    const layout = await service.getPublicSeatLayout('sess1');
    const seats = layout.sections[0].rows[0].seats;
    expect(seats.map((s) => s.status)).toEqual(['SOLD', 'AVAILABLE']);
  });

  it('throws NOT_FOUND when the session or its seat map is missing', async () => {
    const { service } = makeService(null);
    await expect(service.getPublicSeatLayout('missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
