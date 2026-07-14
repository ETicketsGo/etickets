import { Inject, Injectable } from '@nestjs/common';
import {
  ChannelKey,
  NotificationChannel,
  RenderedNotification,
} from './notification-channel.interface';
import { EMAIL_TRANSPORT, EmailLogTransport, EmailTransport } from './transports/email.transport';

/**
 * Email channel. Delivery is delegated to an injected {@link EmailTransport},
 * selected by `EMAIL_PROVIDER` (default `log`, reproducing the original log-only
 * behaviour). SendGrid/SES transports bind the same interface without changing
 * this class. The transport defaults to the log transport so the channel remains
 * directly constructable (e.g. in unit tests) without DI.
 */
@Injectable()
export class EmailChannel implements NotificationChannel {
  readonly key: ChannelKey = 'email';

  constructor(
    @Inject(EMAIL_TRANSPORT)
    private readonly transport: EmailTransport = new EmailLogTransport(),
  ) {}

  async deliver(msg: RenderedNotification): Promise<void> {
    await this.transport.send(msg);
  }
}
