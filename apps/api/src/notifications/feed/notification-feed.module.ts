import { Module } from '@nestjs/common';
import { EventsModule } from '../../events/events.module';
import { NotificationFeedController } from './notification-feed.controller';
import { NotificationFeedService } from './notification-feed.service';

/**
 * Its own module because it reads from both sides: the notifications it folds, and the live
 * sellability check that says whether a fault is still there. EventsModule already sends
 * through NotificationsModule (the sellability sweep does), so importing events from inside
 * NotificationsModule would make a cycle; this sits above both instead.
 */
@Module({
  imports: [EventsModule],
  controllers: [NotificationFeedController],
  providers: [NotificationFeedService],
})
export class NotificationFeedModule {}
