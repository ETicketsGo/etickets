import { Injectable, Logger } from '@nestjs/common';
import {
  ChannelKey,
  NotificationChannel,
  RenderedNotification,
} from './notification-channel.interface';

/**
 * In-app channel. There is no external send: the persisted Notification row IS
 * the in-app notification (surfaced by an in-app inbox query). {@link deliver}
 * only emits a debug log so the dispatch path is observable.
 */
@Injectable()
export class InAppChannel implements NotificationChannel {
  readonly key: ChannelKey = 'in_app';
  private readonly logger = new Logger('Notification');

  async deliver(msg: RenderedNotification): Promise<void> {
    this.logger.debug(`[in_app:${msg.type}] -> user ${msg.userId ?? 'n/a'} (persisted row)`);
  }
}
