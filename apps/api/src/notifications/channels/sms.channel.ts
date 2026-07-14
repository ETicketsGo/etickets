import { Inject, Injectable } from '@nestjs/common';
import {
  ChannelKey,
  NotificationChannel,
  RenderedNotification,
} from './notification-channel.interface';
import { SMS_TRANSPORT, SmsLogTransport, SmsTransport } from './transports/sms.transport';

/**
 * SMS channel. Delivery is delegated to an injected {@link SmsTransport},
 * selected by `SMS_PROVIDER` (default `log`). The Twilio transport reads the
 * recipient from `payload.phone` and skips cleanly when it is absent.
 */
@Injectable()
export class SmsChannel implements NotificationChannel {
  readonly key: ChannelKey = 'sms';

  constructor(
    @Inject(SMS_TRANSPORT)
    private readonly transport: SmsTransport = new SmsLogTransport(),
  ) {}

  async deliver(msg: RenderedNotification): Promise<void> {
    await this.transport.send(msg);
  }
}
