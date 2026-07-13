import { Injectable, Logger } from '@nestjs/common';
import {
  ChannelKey,
  NotificationChannel,
  RenderedNotification,
} from './notification-channel.interface';

/**
 * Push channel. MVP log-only stub — a real provider (e.g. Firebase Cloud
 * Messaging / APNs) would push the rendered subject+body inside {@link deliver}.
 */
@Injectable()
export class PushChannel implements NotificationChannel {
  readonly key: ChannelKey = 'push';
  private readonly logger = new Logger('Notification');

  async deliver(msg: RenderedNotification): Promise<void> {
    this.logger.log(`[push:${msg.type}] -> user ${msg.userId ?? 'n/a'} :: ${msg.subject}`);
  }
}
