import { ReviewsService } from './reviews.service';

/**
 * Who may rate, and how many votes one person is.
 *
 * Ratings now appear on posters and the film page, where they decide what people choose to watch.
 * The rules that make them worth showing: only people whose show has started, and one voice per
 * person per film however many cinemas they saw it in.
 */
const user = { id: 'u1', roles: [] } as never;
const hourAgo = () => new Date(Date.now() - 3_600_000);
const inAnHour = () => new Date(Date.now() + 3_600_000);

function make(
  opts: {
    event?: { id: string; movieId: string | null } | null;
    bookings?: { eventSession: { startsAt: Date } }[];
    earlier?: { id: string } | null;
  } = {},
) {
  const prisma = {
    event: {
      findUnique: jest
        .fn()
        .mockResolvedValue(opts.event === undefined ? { id: 'e1', movieId: null } : opts.event),
    },
    booking: { findMany: jest.fn().mockResolvedValue(opts.bookings ?? []) },
    review: {
      findFirst: jest.fn().mockResolvedValue(opts.earlier ?? null),
      update: jest.fn(async ({ data }: { data: object }) => ({ id: 'r-earlier', ...data })),
      upsert: jest.fn(async ({ create }: { create: object }) => ({ id: 'r-new', ...create })),
    },
  };
  return { prisma, service: new ReviewsService(prisma as never) };
}

describe('ReviewsService.create — who may rate', () => {
  it('refuses someone with no confirmed booking', async () => {
    const { service, prisma } = make({ bookings: [] });
    await expect(service.create(user, { eventId: 'e1', rating: 5 })).rejects.toMatchObject({
      code: 'REVIEW_NOT_ELIGIBLE',
    });
    expect(prisma.review.upsert).not.toHaveBeenCalled();
  });

  it('refuses a booking whose show has not started — a rating of an expectation', async () => {
    const { service, prisma } = make({ bookings: [{ eventSession: { startsAt: inAnHour() } }] });
    await expect(service.create(user, { eventId: 'e1', rating: 5 })).rejects.toMatchObject({
      code: 'REVIEW_NOT_ELIGIBLE',
      message: expect.stringMatching(/once your show has started/),
    });
    expect(prisma.review.upsert).not.toHaveBeenCalled();
  });

  it('accepts once any of the bookings has started', async () => {
    const { service, prisma } = make({
      bookings: [
        { eventSession: { startsAt: inAnHour() } },
        { eventSession: { startsAt: hourAgo() } },
      ],
    });
    await expect(service.create(user, { eventId: 'e1', rating: 4 })).resolves.toMatchObject({
      rating: 4,
    });
    expect(prisma.review.upsert).toHaveBeenCalledTimes(1);
  });

  it('updates the earlier rating of the same film instead of adding a second vote', async () => {
    // Watched in one cinema, rated; watched again in another, rated again: still one opinion.
    const { service, prisma } = make({
      event: { id: 'e2', movieId: 'm1' },
      bookings: [{ eventSession: { startsAt: hourAgo() } }],
      earlier: { id: 'r-earlier' },
    });
    await service.create(user, { eventId: 'e2', rating: 2, comment: 'Less good the second time' });
    expect(prisma.review.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u1', event: { movieId: 'm1' } } }),
    );
    expect(prisma.review.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'r-earlier' } }),
    );
    expect(prisma.review.upsert).not.toHaveBeenCalled();
  });

  it('keeps one review per event for an ordinary event', async () => {
    const { service, prisma } = make({ bookings: [{ eventSession: { startsAt: hourAgo() } }] });
    await service.create(user, { eventId: 'e1', rating: 3 });
    expect(prisma.review.findFirst).not.toHaveBeenCalled();
    expect(prisma.review.upsert).toHaveBeenCalledTimes(1);
  });
});

describe('ReviewsService.mineForMovie — may I rate this film?', () => {
  function forMovie(
    bookings: { eventId: string; eventSession: { startsAt: Date } }[],
    review: object | null = null,
    status = 'PUBLISHED',
  ) {
    const prisma = {
      movie: { findUnique: jest.fn().mockResolvedValue({ id: 'm1', status }) },
      review: { findFirst: jest.fn().mockResolvedValue(review) },
      booking: { findMany: jest.fn().mockResolvedValue(bookings) },
    };
    return new ReviewsService(prisma as never);
  }

  it('says why not when there is no booking for the film', async () => {
    await expect(forMovie([]).mineForMovie(user, 'film')).resolves.toEqual({
      review: null,
      eligibleEventId: null,
      reason: 'NO_BOOKING',
    });
  });

  it('says why not when the show is still ahead', async () => {
    await expect(
      forMovie([{ eventId: 'e1', eventSession: { startsAt: inAnHour() } }]).mineForMovie(
        user,
        'film',
      ),
    ).resolves.toMatchObject({ eligibleEventId: null, reason: 'NOT_STARTED' });
  });

  it('names the listing to rate through once a show has started, with the rating so far', async () => {
    const review = { id: 'r1', rating: 4, comment: null, eventId: 'e1' };
    await expect(
      forMovie(
        [
          { eventId: 'e2', eventSession: { startsAt: inAnHour() } },
          { eventId: 'e1', eventSession: { startsAt: hourAgo() } },
        ],
        review,
      ).mineForMovie(user, 'film'),
    ).resolves.toEqual({ review, eligibleEventId: 'e1', reason: null });
  });

  it('does not confirm that an unpublished film exists', async () => {
    await expect(forMovie([], null, 'DRAFT').mineForMovie(user, 'film')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('ReviewsService.forMovie — the film page summary', () => {
  it('averages one latest rating per viewer and keeps the distribution', async () => {
    const $queryRaw = jest
      .fn()
      .mockResolvedValueOnce([
        { rating: 5, count: 2 },
        { rating: 3, count: 1n },
      ])
      .mockResolvedValueOnce([
        {
          id: 'r1',
          rating: 5,
          comment: 'Loved it',
          createdAt: new Date('2026-09-10'),
          author: 'Asha',
        },
      ]);
    const prisma = {
      movie: { findUnique: jest.fn().mockResolvedValue({ id: 'm1', status: 'PUBLISHED' }) },
      $queryRaw,
    };
    const summary = await new ReviewsService(prisma as never).forMovie('film');
    expect(summary).toMatchObject({
      average: 4.3, // (5 + 5 + 3) / 3
      count: 3,
      distribution: { 1: 0, 2: 0, 3: 1, 4: 0, 5: 2 },
      items: [{ id: 'r1', rating: 5, author: 'Asha' }],
    });
    // Both reads dedupe by viewer, whichever cinema's listing they rated through.
    for (const [strings] of $queryRaw.mock.calls) {
      expect((strings as TemplateStringsArray).join('?')).toContain('DISTINCT ON (r."userId")');
    }
  });
});
