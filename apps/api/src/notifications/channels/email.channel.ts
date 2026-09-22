import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { redirectUrl } from '../../common/console-urls';
import { buildEmailView } from '../templates/email-view';
import { renderEmailHtml } from '../templates/email-html';
import {
  ChannelKey,
  DeliveryOutcome,
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
    @Optional() private readonly config?: ConfigService,
  ) {}

  /**
   * Adds the HTML part, then delivers.
   *
   * Composed HERE rather than in the template service because it is an email concern: the
   * same rendered message goes to SMS, push and the in-app list, and none of them may be
   * handed markup. A transport that cannot send HTML simply ignores the field, so the log
   * transport and any future provider keep working untouched.
   *
   * The text part is never dropped. Some people read mail as text by choice, some clients
   * still cannot render HTML, and a multipart message with both is also what spam filters
   * expect from a genuine sender.
   */
  async deliver(msg: RenderedNotification): Promise<DeliveryOutcome> {
    return this.transport.send({ ...msg, html: this.htmlFor(msg) });
  }

  private htmlFor(msg: RenderedNotification): string | null {
    try {
      return renderEmailHtml(
        buildEmailView({
          type: msg.type,
          locale: msg.locale,
          subject: msg.subject,
          body: msg.body,
          payload: msg.payload ?? {},
          helpUrl: this.config
            ? redirectUrl(this.config, { site: 'customer', path: '/help', purpose: 'email footer' })
            : null,
        }),
      );
    } catch {
      /*
        A message is owed to the reader whatever the layout does. A missing catalogue key or
        an unresolvable site URL must cost the branding, not the ticket, so the send falls
        back to the plain text that has always worked.
      */
      return null;
    }
  }
}
