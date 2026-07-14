import { Inject, Injectable } from '@nestjs/common';
import {
  ChannelKey,
  NotificationChannel,
  RenderedNotification,
} from './notification-channel.interface';
import { PUSH_TRANSPORT, PushLogTransport, PushTransport } from './transports/push.transport';

/**
 * Push channel. Delivery is delegated to an injected {@link PushTransport},
 * selected by `PUSH_PROVIDER` (default `log`). The FCM transport reads the device
 * token(s) from `payload.pushToken` / `payload.pushTokens` and skips cleanly when
 * none are present.
 */
@Injectable()
export class PushChannel implements NotificationChannel {
  readonly key: ChannelKey = 'push';

  constructor(
    @Inject(PUSH_TRANSPORT)
    private readonly transport: PushTransport = new PushLogTransport(),
  ) {}

  async deliver(msg: RenderedNotification): Promise<void> {
    await this.transport.send(msg);
  }
}
