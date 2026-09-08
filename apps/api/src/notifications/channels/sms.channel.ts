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
 * SMS channel.
 *
 * ── WHAT CHANGED, AND WHY IT MATTERED ──────────────────────────────────────────────
 * Two things were broken here, and each one on its own was enough to make the channel
 * unable to send anything.
 *
 * It read the recipient from `payload.phone`, which no caller has ever set. `User.phone` has
 * existed since phone sign-in shipped and is the identity most Indian buyers use, and nothing
 * connected the two — so every SMS the platform has "sent" was skipped with a warning that
 * nobody was reading. That is the same failure that was already found and fixed for push,
 * and this is the same fix.
 *
 * And its provider was a single object chosen once at boot, so a message to Mumbai and a
 * message to Toronto necessarily went the same way. Now the route is decided per message.
 */
@Injectable()
export class SmsChannel implements NotificationChannel {
  readonly key: ChannelKey = 'sms';
  private readonly logger = new Logger('Notification');

  constructor(
    private readonly providers: NotificationProviderResolver,
    private readonly prisma?: PrismaService,
  ) {}

  async deliver(msg: RenderedNotification): Promise<DeliveryOutcome> {
    const addressed = await resolvePhoneDestination(msg, this.prisma);
    if (!addressed.destination) {
      this.logger.warn(
        `[sms:${msg.type}] no phone number on file -> skipped for user ${msg.userId ?? 'n/a'}`,
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

    const routed = this.providers.routeSms(addressed);
    if (!routed.ok) {
      /*
        A refusal is permanent: the market will not resolve differently on the next attempt,
        and retrying for an hour only delays somebody noticing the routing table is
        incomplete. Non-retryable so the notification lands in FAILED with the reason on it.
      */
      throw new TransportError(
        `No SMS provider configured for this destination (${routed.refusal}` +
          `${routed.market ? `, market ${routed.market}` : ''}).`,
        'router',
        // Nobody was called, so nobody failed. This is a routing table that does not cover
        // the destination, and it stays true until somebody edits configuration.
        FailureClass.CONFIGURATION_ERROR,
      );
    }
    return routed.transport.send(addressed);
  }
}
