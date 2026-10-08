import { ShowsService } from './shows.service';

function setup(country: string | null) {
  const ticketTypeCreate = jest.fn().mockResolvedValue({ id: 'tt-1' });
  const tx = {
    eventSession: {
      findUnique: jest.fn().mockResolvedValue({ event: { venue: { country } } }),
    },
    ticketType: { create: ticketTypeCreate },
    showZone: { create: jest.fn() },
    showSeat: { createMany: jest.fn() },
  };
  const service = new ShowsService({} as never, {} as never);
  const seatMap = {
    categories: [
      { id: 'cat-1', name: 'General', basePriceMinor: 2_000, colorHex: null, sortOrder: 0 },
    ],
    seats: [{ id: 'seat-1', seatCategoryId: 'cat-1', kind: 'SEAT' }],
    zones: [],
  } as never;
  return { service, tx, seatMap, ticketTypeCreate };
}

describe('ShowsService seated-session currency authority', () => {
  it.each([
    ['India', 'INR'],
    ['United States', 'USD'],
    ['Canada', 'CAD'],
    ['Australia', 'AUD'],
  ])('maps known venue country %s to %s', async (country, currency) => {
    const { service, tx, seatMap, ticketTypeCreate } = setup(country);
    await service.seatSession(tx as never, 'session-1', seatMap);
    expect(ticketTypeCreate.mock.calls[0][0].data.currency).toBe(currency);
  });

  it.each([null, '', 'Atlantis', 'ZZ'])(
    'refuses unknown venue country %p rather than assigning INR',
    async (country) => {
      const { service, tx, seatMap, ticketTypeCreate } = setup(country);
      await expect(service.seatSession(tx as never, 'session-1', seatMap)).rejects.toMatchObject({
        code: 'CONFLICT',
        details: { reason: 'CURRENCY_CONTEXT_REQUIRED' },
      });
      expect(ticketTypeCreate).not.toHaveBeenCalled();
    },
  );
});
