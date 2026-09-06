import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { NotificationService } from './notification.service';
import { CurrentUser, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

const inboxQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  before: z.coerce.date().optional(),
  /**
   * Which stream to show. The organizer console asks for `ORGANIZER`, the customer site for
   * `CUSTOMER`. Omitted returns everything, so existing callers are unchanged.
   */
  audience: z.enum(['CUSTOMER', 'ORGANIZER', 'ADMIN']).optional(),
});

/** The same choice, for the endpoints that take nothing else. */
const audienceQuerySchema = z.object({
  audience: z.enum(['CUSTOMER', 'ORGANIZER', 'ADMIN']).optional(),
});

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationService) {}

  @Get()
  @ApiOperation({ summary: 'In-app notification inbox for the current user.' })
  inbox(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(inboxQuerySchema))
    q: { limit?: number; before?: Date; audience?: 'CUSTOMER' | 'ORGANIZER' | 'ADMIN' },
  ) {
    /*
      ── `audience` WAS PARSED AND THEN DROPPED ──────────────────────────────────────
      This validated the parameter and did not forward it. Every caller therefore got the
      merged stream no matter what it asked for, and the customer site — which has been
      sending `audience=CUSTOMER` all along — showed an organizer their event approvals and
      organization approvals beside their own ticket confirmations.

      The report described it as a regression, and it is a precise one: the filter was built,
      the callers were updated, and the one line joining them was missing. Nothing failed,
      because a query parameter the server ignores looks exactly like a query parameter the
      server honours until you are the person holding both roles.
    */
    return this.notifications.inbox(user.id, {
      limit: q.limit,
      before: q.before,
      audience: q.audience,
    });
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Count of unread in-app notifications, for one audience.' })
  async unreadCount(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(audienceQuerySchema))
    q: { audience?: 'CUSTOMER' | 'ORGANIZER' | 'ADMIN' },
  ) {
    return { unreadCount: await this.notifications.unreadCount(user.id, q.audience) };
  }

  @Post(':id/read')
  @ApiOperation({ summary: 'Mark a single notification read.' })
  async markRead(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return { updated: await this.notifications.markRead(user.id, id) };
  }

  @Post('read-all')
  @ApiOperation({ summary: 'Mark every notification in one audience read.' })
  async markAllRead(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(audienceQuerySchema))
    q: { audience?: 'CUSTOMER' | 'ORGANIZER' | 'ADMIN' },
  ) {
    return { updated: await this.notifications.markAllRead(user.id, q.audience) };
  }
}
