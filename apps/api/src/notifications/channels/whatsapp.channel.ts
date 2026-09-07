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

    const routed = this.providers.routeWhatsApp(addressed);
    if (!routed.ok) {
      throw new TransportError(
        `No WhatsApp provider configured for this destination (${routed.refusal}` +
          `${routed.market ? `, market ${routed.market}` : ''}).`,
        'router',
        false,
      );
    }
    return routed.transport.send(addressed);
  }
}
