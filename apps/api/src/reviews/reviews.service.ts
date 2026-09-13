import { HttpStatus, Injectable } from '@nestjs/common';
import { BookingStatus } from '@eticketsgo/shared-types';
import type { CreateReviewInput } from '@eticketsgo/validation';
import { PrismaService } from '../prisma/prisma.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';

/** Bookings that mean the customer actually holds a ticket. */
const COUNTED_BOOKINGS = [BookingStatus.CONFIRMED, BookingStatus.PARTIALLY_REFUNDED];

const REVIEW_SELECT = { id: true, rating: true, comment: true, createdAt: true } as const;

@Injectable()
export class ReviewsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Rate an event — or, when the event is a film's cinema listing, the film.
   *
   * ── WHO MAY RATE ───────────────────────────────────────────────────────────────────
   * Someone holding a confirmed booking for the event whose show has STARTED. A booking alone
   * used to be enough, so a buyer could rate a film the morning they booked it, hours before
   * seeing it: a rating of an expectation, counted as a vote on the film. Ratings now appear on
   * posters and decide what people choose to watch, which is exactly when they must come from
   * people who watched.
   *
   * ── ONE VOICE PER PERSON, PER FILM ─────────────────────────────────────────────────
   * A film plays as one listing per cinema. Someone who watched it twice, in two cinemas, is
   * still one opinion about the film, so a second rating through another listing updates their
   * first instead of adding a vote. The public count applies the same rule to anything written
   * before it (see `movieRatingsFor`).
   */
  async create(user: RequestUser, input: CreateReviewInput) {
    const now = new Date();
    const [event, bookings] = await Promise.all([
      this.prisma.event.findUnique({
        where: { id: input.eventId },
        select: { id: true, movieId: true },
      }),
      this.prisma.booking.findMany({
        where: { userId: user.id, eventId: input.eventId, status: { in: COUNTED_BOOKINGS } },
        select: { eventSession: { select: { startsAt: true } } },
      }),
    ]);
    if (!event || bookings.length === 0) {
      throw new AppException(
        ErrorCodes.REVIEW_NOT_ELIGIBLE,
        'Only attendees with a confirmed booking can review this event.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (!bookings.some((booking) => booking.eventSession.startsAt <= now)) {
      throw new AppException(
        ErrorCodes.REVIEW_NOT_ELIGIBLE,
        'You can rate this once your show has started.',
        HttpStatus.FORBIDDEN,
      );
    }

    if (event.movieId) {
      const earlier = await this.prisma.review.findFirst({
        where: { userId: user.id, event: { movieId: event.movieId } },
        orderBy: { updatedAt: 'desc' },
        select: { id: true },
      });
      if (earlier) {
        return this.prisma.review.update({
          where: { id: earlier.id },
          data: { rating: input.rating, comment: input.comment },
          select: REVIEW_SELECT,
        });
      }
    }

    return this.prisma.review.upsert({
      where: { eventId_userId: { eventId: input.eventId, userId: user.id } },
      create: {
        eventId: input.eventId,
        userId: user.id,
        rating: input.rating,
        comment: input.comment,
      },
      update: { rating: input.rating, comment: input.comment },
      select: REVIEW_SELECT,
    });
  }

  /** Public summary + recent reviews for an event. */
  async forEvent(eventId: string) {
    const [ratings, items] = await this.prisma.$transaction([
      this.prisma.review.findMany({ where: { eventId }, select: { rating: true } }),
      this.prisma.review.findMany({
        where: { eventId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          rating: true,
          comment: true,
          createdAt: true,
          user: { select: { fullName: true } },
        },
      }),
    ]);

    const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let sum = 0;
    for (const r of ratings) {
      distribution[r.rating] = (distribution[r.rating] ?? 0) + 1;
      sum += r.rating;
    }
    const total = ratings.length;

    return {
      average: total ? Math.round((sum / total) * 10) / 10 : 0,
      count: total,
      distribution,
      items: items.map((r) => ({
        id: r.id,
        rating: r.rating,
        comment: r.comment,
        author: r.user.fullName,
        createdAt: r.createdAt,
      })),
    };
  }

  /**
   * A film's rating across every cinema showing it, and its most recent reviews.
   *
   * One voice per person: each viewer's latest rating of the film, whichever listing it went
   * through. Same shape as an event's summary, so the storefront renders both the same way.
   */
  async forMovie(slug: string) {
    const movie = await this.publishedMovie(slug);
    const latest = (columns: 'rating' | 'all') =>
      columns === 'rating'
        ? this.prisma.$queryRaw<{ rating: number; count: number | bigint }[]>`
            SELECT latest."rating" AS rating, COUNT(*)::int AS count
            FROM (
              SELECT DISTINCT ON (r."userId") r."rating"
              FROM "Review" r
              JOIN "Event" e ON e."id" = r."eventId"
              WHERE e."movieId" = ${movie.id}
              ORDER BY r."userId", r."updatedAt" DESC
            ) latest
            GROUP BY latest."rating"`
        : this.prisma.$queryRaw<
            {
              id: string;
              rating: number;
              comment: string | null;
              createdAt: Date;
              author: string;
            }[]
          >`
            SELECT latest.*
            FROM (
              SELECT DISTINCT ON (r."userId")
                     r."id", r."rating", r."comment", r."createdAt", r."updatedAt",
                     u."fullName" AS author
              FROM "Review" r
              JOIN "Event" e ON e."id" = r."eventId"
              JOIN "User" u ON u."id" = r."userId"
              WHERE e."movieId" = ${movie.id}
              ORDER BY r."userId", r."updatedAt" DESC
            ) latest
            ORDER BY latest."updatedAt" DESC
            LIMIT 20`;

    const [byRating, items] = await Promise.all([latest('rating'), latest('all')]);
    const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let sum = 0;
    let total = 0;
    for (const row of byRating as { rating: number; count: number | bigint }[]) {
      const count = Number(row.count);
      distribution[row.rating] = count;
      sum += row.rating * count;
      total += count;
    }

    return {
      average: total ? Math.round((sum / total) * 10) / 10 : 0,
      count: total,
      distribution,
      items: (
        items as {
          id: string;
          rating: number;
          comment: string | null;
          createdAt: Date;
          author: string;
        }[]
      ).map((r) => ({
        id: r.id,
        rating: r.rating,
        comment: r.comment,
        author: r.author,
        createdAt: r.createdAt,
      })),
    };
  }

  /**
   * Whether the signed-in customer can rate this film, and through which listing.
   *
   * The storefront needs to know before offering the stars: someone who has not booked the
   * film, or whose show is still ahead, is told why rather than shown a form that refuses them.
   */
  async mineForMovie(user: RequestUser, slug: string) {
    const movie = await this.publishedMovie(slug);
    const now = new Date();
    const [review, bookings] = await Promise.all([
      this.prisma.review.findFirst({
        where: { userId: user.id, event: { movieId: movie.id } },
        orderBy: { updatedAt: 'desc' },
        select: { id: true, rating: true, comment: true, eventId: true },
      }),
      this.prisma.booking.findMany({
        where: { userId: user.id, status: { in: COUNTED_BOOKINGS }, event: { movieId: movie.id } },
        orderBy: { eventSession: { startsAt: 'desc' } },
        select: { eventId: true, eventSession: { select: { startsAt: true } } },
      }),
    ]);
    const watched = bookings.find((booking) => booking.eventSession.startsAt <= now);
    return {
      review,
      eligibleEventId: watched?.eventId ?? null,
      reason: watched
        ? null
        : bookings.length > 0
          ? ('NOT_STARTED' as const)
          : ('NO_BOOKING' as const),
    };
  }

  /** The current user's own review for an event, if any. */
  async mine(user: RequestUser, eventId: string) {
    return this.prisma.review.findUnique({
      where: { eventId_userId: { eventId, userId: user.id } },
      select: { id: true, rating: true, comment: true },
    });
  }

  /** A film the public may see, or "not found" — an unpublished film is indistinguishable from none. */
  private async publishedMovie(slug: string) {
    const movie = await this.prisma.movie.findUnique({
      where: { slug },
      select: { id: true, status: true },
    });
    if (!movie || movie.status !== 'PUBLISHED') {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Movie not found.', HttpStatus.NOT_FOUND);
    }
    return movie;
  }
}
