import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, type RequestUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { NotificationFeedService } from './notification-feed.service';

const feedQuerySchema = z.object({
  audience: z.enum(['CUSTOMER', 'ORGANIZER', 'ADMIN']).optional(),
});

/**
 * Bounded so one request cannot ask the database to touch an unbounded list. A card folds at
 * most the feed's own row limit, so nothing legitimate sends more.
 */
const readManyBody = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(200),
});

/**
 * The grouped notification centre, beside the flat inbox rather than replacing it.
 *
 * The flat `GET /notifications` stays exactly as it was: the customer site, the mobile app and
 * the bell all read it, and none of them needs a page of sections and folded causes.
 */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationFeedController {
  constructor(private readonly feed: NotificationFeedService) {}

  @Get('feed')
  @ApiOperation({
    summary: 'Notifications grouped by what to do, with repeats of one cause folded into one card.',
  })
  get(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(feedQuerySchema))
    q: z.infer<typeof feedQuerySchema>,
  ) {
    return this.feed.feed(user.id, q.audience);
  }

  @Post('read-many')
  @ApiOperation({ summary: 'Mark several of your own notifications read (one folded card).' })
  async readMany(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(readManyBody)) body: z.infer<typeof readManyBody>,
  ) {
    return { updated: await this.feed.markManyRead(user.id, body.ids) };
  }
}
