import { Injectable, Logger } from '@nestjs/common';
import {
  ChannelKey,
  DeliveryOutcome,
  NotificationChannel,
  RenderedNotification,
} from './notification-channel.interface';
import { NotificationProviderResolver } from './notification-provider.resolver';
import { PrismaService } from '../../prisma/prisma.service';
import { resolvePhoneDestination } from './phone-destination';
import { FailureClass } from '@eticketsgo/shared-types';
import { validateTemplatePayload } from '../templates/template-contract';
import { TransportError } from './transports/transport-http';

/**
 * WhatsApp channel. Same two fixes as the SMS channel: the recipient comes from their own
 * account rather than from a payload nobody ever filled in, and the provider is chosen per
 * message — MSG91 into India, Meta's Cloud API into North America — instead of once at boot.
 *
 * The Meta Cloud adapter is deliberately kept rather than replaced by a single vendor: it
 * works, it needs no business solution provider in between, and a working integration is
 * worth more than a uniform one.
 */
@Injectable()
export class WhatsAppChannel implements NotificationChannel {
  readonly key: ChannelKey = 'whatsapp';
  private readonly logger = new Logger('Notification');

  constructor(
    private readonly providers: NotificationProviderResolver,
    private readonly prisma?: PrismaService,
  ) {}

  async deliver(msg: RenderedNotification): Promise<DeliveryOutcome> {
    const addressed = await resolvePhoneDestination(msg, this.prisma);
    if (!addressed.destination) {
      this.logger.warn(
        `[whatsapp:${msg.type}] no phone number on file -> skipped for user ${msg.userId ?? 'n/a'}`,
      );
      return { provider: 'none', skipped: true, reason: 'no_destination' };
    }

    /*
      A provider TEMPLATE has a fixed number of variables, and a blank one is not a shorter
      message -- it is a message that no longer matches the wording the operator approved,
      delivered with a hole in the middle of it or refused at the carrier.

      Checked here and NOT on email or the inbox. There the same missing field renders as a
      vaguer sentence, and a vague warning about a cancelled show is far better than silence:
      refusing to send would turn a degraded message into no message at all, for the one type
      where somebody might otherwise travel to a dark venue.
    */
    const violation = validateTemplatePayload(msg.type, msg.payload);
    if (violation) {
      throw new TransportError(
        `${msg.type} is missing required template variable(s): ${violation.missing.join(', ')}. ` +
          `The producer did not supply them; retrying sends the same incomplete message.`,
        'template',
        FailureClass.CONFIGURATION_ERROR,
      );
    }

    const routed = this.providers.routeWhatsApp(addressed);
    if (!routed.ok) {
      throw new TransportError(
        `No WhatsApp provider configured for this destination (${routed.refusal}` +
          `${routed.market ? `, market ${routed.market}` : ''}).`,
        'router',
        FailureClass.CONFIGURATION_ERROR,
      );
    }
    return routed.transport.send(addressed);
  }
}
