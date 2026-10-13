import { PublicMoviesService } from './movies.service';

/**
 * A show that cannot be bought online is not offered as bookable.
 *
 * QA, Hyderabad chosen: the film page and the home listed a Telangana show with a price, and
 * opening it said "Online booking is not open". The rule "a film is listed only if you can buy a
 * ticket" has to look at SALE eligibility (the answer checkout gives), not only at the event's
 * status. The restriction itself is not touched: these tests only read its answer.
 */

const passthroughCache = () =>
  ({
    getOrSet: jest.fn((_k: string, _t: number, producer: () => Promise<unknown>) => producer()),
  }) as never;

const advertised = { forListing: (x: unknown) => x, forTicket: async () => 25000 } as never;

/** sessionStates answer for a show: open, or closed with no sellable ticket type. */
function answer(sessionId: string, open: boolean) {
  return {
    state: { sessionId },
    eligibility: { sellable: open, blockers: [], sellableTicketTypeIds: open ? ['t'] : [] },
  };
}

describe('closed-sales shows on the public film surfaces', () => {
  it('drops a film whose only showing in scope is closed, keeps one that can be bought', async () => {
    const prisma = {
      movie: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'm-closed', title: 'A', slug: 'a', genres: [] },
          { id: 'm-open', title: 'B', slug: 'b', genres: [] },
        ]),
      },
      eventSession: {
        findMany: jest.fn().mockResolvedValue([
          { id: 's1', event: { movieId: 'm-closed' } },
          { id: 's2', event: { movieId: 'm-open' } },
          { id: 's3', event: { movieId: 'm-open' } },
        ]),
      },
      // movieRatingsFor reads this; an empty answer is fine.
      $queryRaw: jest.fn().mockResolvedValue([]),
    } as never;
    const sales = {
      sessionStates: jest
        .fn()
        .mockResolvedValue([answer('s1', false), answer('s2', false), answer('s3', true)]),
    } as never;
    const service = new PublicMoviesService(prisma, passthroughCache(), advertised, sales);
    const cards = (await service.list({ city: 'Hyderabad' } as never)) as { id: string }[];
    expect(cards.map((c) => c.id)).toEqual(['m-open']);
  });

  it('lists the film when every showing is open (the service changes nothing for sellable shows)', async () => {
    const prisma = {
      movie: { findMany: jest.fn().mockResolvedValue([{ id: 'm1', genres: [] }]) },
      eventSession: {
        findMany: jest.fn().mockResolvedValue([{ id: 's1', event: { movieId: 'm1' } }]),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
    } as never;
    const sales = { sessionStates: jest.fn().mockResolvedValue([answer('s1', true)]) } as never;
    const service = new PublicMoviesService(prisma, passthroughCache(), advertised, sales);
    const cards = (await service.list({})) as { id: string }[];
    expect(cards.map((c) => c.id)).toEqual(['m1']);
  });

  it('film page: a closed show is not returned, so no buy action can be drawn for it', async () => {
    const mk = (id: string) => ({
      id,
      screenId: null,
      status: 'SCHEDULED',
      startsAt: new Date('2099-09-01T14:00:00.000Z'),
      endsAt: new Date('2099-09-01T16:00:00.000Z'),
      event: {
        id: 'ev',
        slug: 'ev',
        feeMode: 'ADDED',
        venue: { id: 'v', name: 'V', city: 'Hyderabad', country: 'India', region: 'Telangana' },
      },
      screen: null,
      ticketTypes: [
        {
          id: 'tt',
          priceMinor: 25000,
          currency: 'INR',
          inventory: { quantityTotal: 10, quantitySold: 0, quantityHeld: 0 },
        },
      ],
    });
    const prisma = {
      movie: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'm',
          organizationId: 'o',
          status: 'PUBLISHED',
          title: 'T',
          slug: 't',
          genres: [],
          cast: [],
        }),
      },
      eventSession: { count: jest.fn(), findMany: jest.fn() },
      showSeat: { groupBy: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn().mockResolvedValue([2, [mk('closed'), mk('open')]]),
      $queryRaw: jest.fn().mockResolvedValue([]),
    } as never;
    const sales = {
      sessionStates: jest.fn().mockResolvedValue([answer('closed', false), answer('open', true)]),
    } as never;
    const service = new PublicMoviesService(prisma, passthroughCache(), advertised, sales);
    const out = await service.shows('t', { limit: 50 } as never);
    expect(out.shows.map((x) => x.sessionId)).toEqual(['open']);
    expect(out.meta.total).toBe(1);
  });
});
