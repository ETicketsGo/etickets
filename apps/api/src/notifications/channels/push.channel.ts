import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ChannelKey,
  DeliveryOutcome,
  NotificationChannel,
  RenderedNotification,
} from './notification-channel.interface';
import { PUSH_TRANSPORT, PushLogTransport, PushTransport } from './transports/push.transport';
import { WebPushService } from '../web-push/web-push.service';
import { PrismaService } from '../../prisma/prisma.service';
import { payloadPushTokens } from './transports/recipient.util';
import { safeNotificationLink } from './link-safety';

/**
 * Push channel. Delivers to the recipient's registered mobile devices and to their browser
 * Web Push subscriptions. Both paths skip cleanly when there is no recipient, so this
 * channel is safe as a default.
 *
 * ── WHY IT LOOKS DEVICES UP ───────────────────────────────────────────────────────
 * It used to send only to `payload.pushToken(s)` — tokens the CALLER had to supply. No
 * caller ever did. The mobile app registered devices, rows accumulated in `UserDevice`,
 * and not one push could reach a phone, because the half of the system that knew the
 * tokens and the half that sent them were never introduced.
 *
 * So the channel now resolves the recipient's own devices. A caller may still pass tokens
 * explicitly — addressing a specific device, or a recipient with no account — and both
 * sources are merged, so nothing that worked before changes.
 *
 * Devices whose OS permission was denied are excluded: sending to them is guaranteed
 * waste, and on Expo it earns a `DeviceNotRegistered` back.
 */
@Injectable()
export class PushChannel implements NotificationChannel {
  readonly key: ChannelKey = 'push';

  constructor(
    @Inject(PUSH_TRANSPORT)
    private readonly transport: PushTransport = new PushLogTransport(),
    private readonly webPush?: WebPushService,
    private readonly prisma?: PrismaService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  async deliver(msg: RenderedNotification): Promise<DeliveryOutcome> {
    const outcome = await this.transport.send(await this.withRegisteredDevices(msg));
    // Browser Web Push fan-out to the recipient's subscriptions (best-effort).
    if (this.webPush && msg.userId) {
      /*
        The tap target, checked against the sites this deployment owns.

        It used to be whatever the payload said. A payload is assembled by whichever service
        is sending, so any producer could put any URL into a notification that arrives under
        this platform's name and icon -- a phishing primitive with our branding on it, needing
        no compromise to exercise. An unowned or non-HTTPS link is dropped and the push still
        goes: a notification without a deep link is mildly worse, and one carrying somebody
        else's link is a different kind of thing entirely.
      */
      const url = this.config
        ? (safeNotificationLink(this.config, msg.payload?.url) ?? undefined)
        : undefined;
      await this.webPush
        .dispatchToUser(msg.userId, { title: msg.subject, body: msg.body, url, tag: msg.type })
        .catch(() => undefined);
    }
    return outcome;
  }

  /**
   * Merge the recipient's registered device tokens into the payload.
   *
   * Best-effort: a lookup failure must not lose the notification, which is also written to
   * the in-app inbox and emailed. Returns the message untouched when there is no user, no
   * database, or no device.
   */
  private async withRegisteredDevices(msg: RenderedNotification): Promise<RenderedNotification> {
    if (!this.prisma || !msg.userId) return msg;

    const devices = await this.prisma.userDevice
      .findMany({
        where: { userId: msg.userId, permissionStatus: { not: 'denied' } },
        select: { token: true },
      })
      .catch(() => [] as { token: string }[]);
    if (devices.length === 0) return msg;

    const explicit = payloadPushTokens(msg);
    const merged = [...new Set([...explicit, ...devices.map((d) => d.token)])];
    return { ...msg, payload: { ...(msg.payload ?? {}), pushTokens: merged } };
  }
}
