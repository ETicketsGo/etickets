import { HttpStatus, Injectable } from '@nestjs/common';
import { BookingStatus } from '@eticketsgo/shared-types';
import type { CreateReviewInput } from '@eticketsgo/validation';
import { PrismaService } from '../prisma/prisma.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';

@Injectable()
export class ReviewsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Only attendees with a confirmed booking may review an event. */
  async create(user: RequestUser, input: CreateReviewInput) {
    const booking = await this.prisma.booking.findFirst({
      where: {
        userId: user.id,
        eventId: input.eventId,
        status: { in: [BookingStatus.CONFIRMED, BookingStatus.PARTIALLY_REFUNDED] },
      },
      select: { id: true },
    });
    if (!booking) {
      throw new AppException(
        ErrorCodes.REVIEW_NOT_ELIGIBLE,
        'Only attendees with a confirmed booking can review this event.',
        HttpStatus.FORBIDDEN,
      );
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
      select: { id: true, rating: true, comment: true, createdAt: true },
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

  /** The current user's own review for an event, if any. */
  async mine(user: RequestUser, eventId: string) {
    return this.prisma.review.findUnique({
      where: { eventId_userId: { eventId, userId: user.id } },
      select: { id: true, rating: true, comment: true },
    });
  }
}
