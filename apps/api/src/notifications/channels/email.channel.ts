import { Injectable, Logger } from '@nestjs/common';
import {
  ChannelKey,
  NotificationChannel,
  RenderedNotification,
} from './notification-channel.interface';

/**
 * Email channel. MVP logs the email body locally, reproducing the original
 * NotificationService log style. A real provider (e.g. SendGrid) would bind
 * inside {@link deliver} in place of the log call.
 */
@Injectable()
export class EmailChannel implements NotificationChannel {
  readonly key: ChannelKey = 'email';
  private readonly logger = new Logger('Notification');

  async deliver(msg: RenderedNotification): Promise<void> {
    this.logger.log(
      `[email:${msg.type}] -> ${msg.toEmail ?? 'n/a'} :: ${JSON.stringify(msg.payload)}`,
    );
  }
}
