import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isReservedEmail } from '@eticketsgo/shared-types';
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
import { replyToFor } from './reply-to';

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
    /*
      Never mail a placeholder. A phone-only account's address is an identifier in a domain we
      keep for ourselves; sending to it bounces, and bounces count against the sender. It is a
      message with nowhere to go - skipped, not failed, so nothing retries it.
    */
    if (isReservedEmail(msg.toEmail)) {
      return { provider: 'none', skipped: true, reason: 'no_deliverable_email' };
    }
    /*
      Never hand a real provider an address in a domain that cannot receive mail. QA's seeded
      accounts live at `@eticketsgo.test`; SES accepted every message to them and each one came
      back as a bounce - 398 of them on QA by 2026-10-22 - which costs money and counts against the
      sending account's reputation. The log transport sends nothing anyway, so local and test
      runs that use these addresses are left exactly as they were.
    */
    if (this.transport.name !== 'log' && isSpecialUseEmailDomain(msg.toEmail)) {
      return { provider: 'none', skipped: true, reason: 'no_deliverable_email' };
    }
    /*
      Reply-To only for the types allowed one, and only a plain address: see reply-to.ts. The
      payload never sets any other header.
    */
    return this.transport.send({
      ...msg,
      html: this.htmlFor(msg),
      replyTo: replyToFor(msg.type, msg.payload),
    });
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

/**
 * Domains reserved by RFC 2606 / RFC 6761 that can never receive mail: the `.test`, `.example`,
 * `.invalid` and `.localhost` top-level domains, and `example.com` / `.net` / `.org` with any
 * subdomain.
 */
export function isSpecialUseEmailDomain(email: string | null | undefined): boolean {
  const domain = (email ?? '').trim().toLowerCase().split('@')[1] ?? '';
  if (!domain) return false;
  const tld = domain.split('.').pop() ?? '';
  if (['test', 'example', 'invalid', 'localhost'].includes(tld)) return true;
  return ['example.com', 'example.net', 'example.org'].some(
    (d) => domain === d || domain.endsWith(`.${d}`),
  );
}
