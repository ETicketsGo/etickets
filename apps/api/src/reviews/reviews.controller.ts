import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { createReviewSchema, type CreateReviewInput } from '@eticketsgo/validation';
import { ReviewsService } from './reviews.service';
import { CurrentUser, Public, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

@ApiTags('reviews')
@Controller('reviews')
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Post()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create or update your review for an event.' })
  create(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(createReviewSchema)) body: CreateReviewInput,
  ) {
    return this.reviews.create(user, body);
  }

  @Get('mine')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get your review for an event, if any.' })
  mine(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(z.object({ eventId: z.string().cuid() }))) q: { eventId: string },
  ) {
    return this.reviews.mine(user, q.eventId);
  }
}

@ApiTags('public')
@Controller('public/reviews')
export class PublicReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Public()
  @Get(':eventId')
  @ApiOperation({ summary: 'Public rating summary and recent reviews for an event.' })
  forEvent(@Param('eventId') eventId: string) {
    return this.reviews.forEvent(eventId);
  }
}
