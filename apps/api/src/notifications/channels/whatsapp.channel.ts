import { Inject, Injectable } from '@nestjs/common';
import {
  ChannelKey,
  NotificationChannel,
  RenderedNotification,
} from './notification-channel.interface';
import {
  WHATSAPP_TRANSPORT,
  WhatsAppLogTransport,
  WhatsAppTransport,
} from './transports/whatsapp.transport';

/**
 * WhatsApp channel. Delivery is delegated to an injected {@link WhatsAppTransport},
 * selected by `WHATSAPP_PROVIDER` (default `log`). The Cloud API transport reads
 * the recipient from `payload.phone` and skips cleanly when it is absent.
 */
@Injectable()
export class WhatsAppChannel implements NotificationChannel {
  readonly key: ChannelKey = 'whatsapp';

  constructor(
    @Inject(WHATSAPP_TRANSPORT)
    private readonly transport: WhatsAppTransport = new WhatsAppLogTransport(),
  ) {}

  async deliver(msg: RenderedNotification): Promise<void> {
    await this.transport.send(msg);
  }
}
