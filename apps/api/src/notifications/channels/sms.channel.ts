import { Injectable, Logger } from '@nestjs/common';
import {
  ChannelKey,
  NotificationChannel,
  RenderedNotification,
} from './notification-channel.interface';

/**
 * SMS channel. MVP log-only stub — a real provider (e.g. Twilio) would send the
 * rendered body to the user's phone number inside {@link deliver}.
 */
@Injectable()
export class SmsChannel implements NotificationChannel {
  readonly key: ChannelKey = 'sms';
  private readonly logger = new Logger('Notification');

  async deliver(msg: RenderedNotification): Promise<void> {
    this.logger.log(`[sms:${msg.type}] -> user ${msg.userId ?? 'n/a'} :: ${msg.body}`);
  }
}
