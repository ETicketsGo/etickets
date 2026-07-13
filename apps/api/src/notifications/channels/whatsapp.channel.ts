import { Injectable, Logger } from '@nestjs/common';
import {
  ChannelKey,
  NotificationChannel,
  RenderedNotification,
} from './notification-channel.interface';

/**
 * WhatsApp channel. MVP log-only stub — a real provider (e.g. Twilio WhatsApp
 * Business API) would send the rendered body inside {@link deliver}.
 */
@Injectable()
export class WhatsAppChannel implements NotificationChannel {
  readonly key: ChannelKey = 'whatsapp';
  private readonly logger = new Logger('Notification');

  async deliver(msg: RenderedNotification): Promise<void> {
    this.logger.log(`[whatsapp:${msg.type}] -> user ${msg.userId ?? 'n/a'} :: ${msg.body}`);
  }
}
