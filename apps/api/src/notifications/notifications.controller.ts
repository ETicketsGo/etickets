import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { NotificationService } from './notification.service';
import { CurrentUser, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

const inboxQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  before: z.coerce.date().optional(),
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
    @Query(new ZodValidationPipe(inboxQuerySchema)) q: { limit?: number; before?: Date },
  ) {
    return this.notifications.inbox(user.id, { limit: q.limit, before: q.before });
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Count of unread in-app notifications.' })
  async unreadCount(@CurrentUser() user: RequestUser) {
    return { unreadCount: await this.notifications.unreadCount(user.id) };
  }

  @Post(':id/read')
  @ApiOperation({ summary: 'Mark a single notification read.' })
  async markRead(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return { updated: await this.notifications.markRead(user.id, id) };
  }

  @Post('read-all')
  @ApiOperation({ summary: 'Mark all notifications read.' })
  async markAllRead(@CurrentUser() user: RequestUser) {
    return { updated: await this.notifications.markAllRead(user.id) };
  }
}
