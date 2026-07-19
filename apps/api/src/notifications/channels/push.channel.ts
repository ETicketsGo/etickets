import { Inject, Injectable } from '@nestjs/common';
import {
  ChannelKey,
  NotificationChannel,
  RenderedNotification,
} from './notification-channel.interface';
import { PUSH_TRANSPORT, PushLogTransport, PushTransport } from './transports/push.transport';
import { WebPushService } from '../web-push/web-push.service';

/**
 * Push channel. Delivers to BOTH native device tokens (FCM transport, keyed on
 * `PUSH_PROVIDER`, reading `payload.pushToken(s)`) and — new in v1.4 — the user's
 * registered browser Web Push subscriptions via {@link WebPushService}. Both paths
 * skip cleanly when there is no recipient, so this channel is safe as a default.
 */
@Injectable()
export class PushChannel implements NotificationChannel {
  readonly key: ChannelKey = 'push';

  constructor(
    @Inject(PUSH_TRANSPORT)
    private readonly transport: PushTransport = new PushLogTransport(),
    private readonly webPush?: WebPushService,
  ) {}

  async deliver(msg: RenderedNotification): Promise<void> {
    await this.transport.send(msg);
    // Browser Web Push fan-out to the recipient's subscriptions (best-effort).
    if (this.webPush && msg.userId) {
      const url = typeof msg.payload?.url === 'string' ? msg.payload.url : undefined;
      await this.webPush
        .dispatchToUser(msg.userId, { title: msg.subject, body: msg.body, url, tag: msg.type })
        .catch(() => undefined);
    }
  }
}
