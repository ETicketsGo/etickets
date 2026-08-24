import { PublicEventsService } from './public-events.service';
import { AdvertisedPriceService } from '../pricing/advertised-price.service';

// PRICE_DISPLAY_MODE defaults to `itemised`, in which the advertised-price service returns
// prices exactly as stored and never touches the database. Passing the real service (rather
// than a stub returning a fixed number) keeps these tests honest about the default: if the
// default ever changed to all_in, the price assertions here would move and say so.
const advertised = new AdvertisedPriceService(
  { feeRule: { findMany: async () => [] } } as never,
  { get: () => undefined } as never,
);

describe('PublicEventsService.list search', () => {
  function makeService() {
    const count = jest.fn().mockReturnValue(0);
    const findMany = jest.fn().mockReturnValue([]);
    const prisma = {
      event: { count, findMany },
      $transaction: jest.fn().mockResolvedValue([0, []]),
    };
    return { service: new PublicEventsService(prisma as never, advertised), count, findMany };
  }

  it('matches q against title, organizer name, and venue name/city', async () => {
    const { service, count } = makeService();

    await service.list({ q: 'jazz', page: 1, pageSize: 10 });

    const where = count.mock.calls[0][0].where;
    expect(Array.isArray(where.OR)).toBe(true);
    expect(where.OR).toHaveLength(4);
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { title: { contains: 'jazz', mode: 'insensitive' } },
        { organization: { name: { contains: 'jazz', mode: 'insensitive' } } },
        { venue: { name: { contains: 'jazz', mode: 'insensitive' } } },
        { venue: { city: { contains: 'jazz', mode: 'insensitive' } } },
      ]),
    );
  });

  it('omits the OR clause when q is absent (existing behaviour preserved)', async () => {
    const { service, count } = makeService();

    await service.list({ page: 1, pageSize: 10, category: 'Music' });

    const where = count.mock.calls[0][0].where;
    expect(where.OR).toBeUndefined();
    expect(where.category).toEqual({ equals: 'Music', mode: 'insensitive' });
  });
});

describe('PublicEventsService.categoriesWithCounts', () => {
  it('returns categories sorted by count desc then name asc', async () => {
    const prisma = {
      event: {
        groupBy: jest.fn().mockResolvedValue([
          { category: 'Comedy', _count: { _all: 2 } },
          { category: 'Music', _count: { _all: 5 } },
          { category: 'Arts', _count: { _all: 2 } },
        ]),
      },
    };
    const service = new PublicEventsService(prisma as never, advertised);

    const result = await service.categoriesWithCounts();

    expect(result).toEqual([
      { category: 'Music', count: 5 },
      { category: 'Arts', count: 2 },
      { category: 'Comedy', count: 2 },
    ]);
  });
});
