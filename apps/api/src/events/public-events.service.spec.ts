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

describe('PublicEventsService.list geography', () => {
  function makeService() {
    const count = jest.fn().mockReturnValue(0);
    const findMany = jest.fn().mockReturnValue([]);
    const prisma = {
      event: { count, findMany },
      $transaction: jest.fn().mockResolvedValue([0, []]),
    };
    return { service: new PublicEventsService(prisma as never, advertised), count, findMany };
  }

  it('scopes to a country by every spelling of it, so `IN` finds venues stored as `India`', async () => {
    const { service, count } = makeService();

    await service.list({ country: 'IN', page: 1, pageSize: 10 });

    const venue = count.mock.calls[0][0].where.venue;
    expect(venue.country.mode).toBe('insensitive');
    expect(venue.country.in).toEqual(expect.arrayContaining(['in', 'india']));
  });

  it('lets a city win over a country instead of ANDing the two', async () => {
    /*
      The failure this prevents: a header says US, the customer picks Mumbai, and the query
      asks for a Mumbai in the United States — an empty page for a city they chose by hand.
      The narrower intent is the real one.
    */
    const { service, count } = makeService();

    await service.list({ city: 'Mumbai', country: 'US', page: 1, pageSize: 10 });

    const venue = count.mock.calls[0][0].where.venue;
    expect(venue).toEqual({ city: { equals: 'Mumbai', mode: 'insensitive' } });
    expect(venue.country).toBeUndefined();
  });

  it('applies no geography at all when neither is given', async () => {
    const { service, count } = makeService();

    await service.list({ page: 1, pageSize: 10 });

    expect(count.mock.calls[0][0].where.venue).toBeUndefined();
  });
});

describe('PublicEventsService.list only offers what can still be attended', () => {
  function makeService() {
    const count = jest.fn().mockReturnValue(0);
    const findMany = jest.fn().mockReturnValue([]);
    const prisma = {
      event: { count, findMany },
      $transaction: jest.fn().mockResolvedValue([0, []]),
    };
    return { service: new PublicEventsService(prisma as never, advertised), count, findMany };
  }

  it('requires an upcoming session', async () => {
    const { service, count } = makeService();
    const before = new Date();

    await service.list({ page: 1, pageSize: 10 });

    const gte = count.mock.calls[0][0].where.sessions.some.startsAt.gte as Date;
    expect(gte.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });

  it('reads the price and date off the next session, not the first one ever scheduled', async () => {
    /*
      A run of shows that opened last month used to advertise its opening night — a date
      already past — as the thing you were about to buy. Single-session events hid it,
      which is why it survived: it only appears on the multi-date runs that theatres and
      cinemas exist to sell.
    */
    const { service, findMany } = makeService();
    const before = new Date();

    await service.list({ page: 1, pageSize: 10 });

    const sessions = findMany.mock.calls[0][0].include.sessions;
    expect(sessions.orderBy).toEqual({ startsAt: 'asc' });
    expect((sessions.where.startsAt.gte as Date).getTime()).toBeGreaterThanOrEqual(
      before.getTime() - 1000,
    );
  });

  it('narrows to a requested date range but never widens back into the past', async () => {
    const { service, count } = makeService();
    const lastYear = new Date(Date.now() - 365 * 24 * 3600 * 1000);
    const before = new Date();

    await service.list({ dateFrom: lastYear, page: 1, pageSize: 10 });

    const gte = count.mock.calls[0][0].where.sessions.some.startsAt.gte as Date;
    expect(gte.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });

  it('honours a future date range as given', async () => {
    const { service, count } = makeService();
    const nextMonth = new Date(Date.now() + 30 * 24 * 3600 * 1000);

    await service.list({ dateFrom: nextMonth, page: 1, pageSize: 10 });

    expect(count.mock.calls[0][0].where.sessions.some.startsAt.gte).toEqual(nextMonth);
  });

  it('filters free events on the declared flag rather than on a zero price', async () => {
    // Free-ness is a property the organizer declares. Inferring it from a ticket type
    // priced at zero would also catch a paid event whose comp tier happens to be free.
    const { service, count } = makeService();

    await service.list({ freeOnly: true, page: 1, pageSize: 10 });

    expect(count.mock.calls[0][0].where.isFree).toBe(true);
  });

  it('does not mention isFree when the filter is off', async () => {
    const { service, count } = makeService();

    await service.list({ page: 1, pageSize: 10 });

    expect(count.mock.calls[0][0].where.isFree).toBeUndefined();
  });
});
