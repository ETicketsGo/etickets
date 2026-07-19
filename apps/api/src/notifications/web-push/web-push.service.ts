import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import {
  WEB_PUSH_DISPATCHER,
  type WebPushDispatcher,
  type WebPushMessage,
} from './web-push.dispatcher';

export interface SubscribeInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
}

/**
 * Browser Web Push subscriptions (v1.4). Stores the standard public subscription
 * material and fans a message out to a user's browsers through the pluggable
 * dispatcher. Delivery is a placeholder by default (see LogWebPushDispatcher); the
 * whole register → dispatch → prune path is real so a VAPID transport is a drop-in.
 */
@Injectable()
export class WebPushService {
  private readonly logger = new Logger('WebPush');

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(WEB_PUSH_DISPATCHER) private readonly dispatcher: WebPushDispatcher,
  ) {}

  /** The non-secret VAPID public key browsers need to subscribe, or null if unset. */
  vapidPublicKey(): string | null {
    return this.config.get<string>('VAPID_PUBLIC_KEY') ?? null;
  }

  /** Upsert a subscription for a user (endpoint is the natural key). */
  async subscribe(userId: string, input: SubscribeInput) {
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: input.endpoint },
      create: {
        userId,
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        userAgent: input.userAgent ?? null,
      },
      update: {
        userId,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        userAgent: input.userAgent ?? null,
      },
    });
    return { subscribed: true };
  }

  /** Remove a subscription by endpoint (owner-scoped). */
  async unsubscribe(userId: string, endpoint: string) {
    const res = await this.prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
    return { removed: res.count };
  }

  /**
   * Fan a message out to all of a user's browser subscriptions. Subscriptions the
   * transport reports as permanently gone (404/410) are pruned. Best-effort: never
   * throws into the notification pipeline.
   */
  async dispatchToUser(userId: string, message: WebPushMessage): Promise<number> {
    const subs = await this.prisma.pushSubscription.findMany({ where: { userId } });
    if (subs.length === 0) return 0;
    let delivered = 0;
    for (const sub of subs) {
      try {
        const result = await this.dispatcher.send(
          { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
          message,
        );
        if (result.gone) {
          await this.prisma.pushSubscription
            .delete({ where: { id: sub.id } })
            .catch(() => undefined);
        } else if (result.ok) {
          delivered += 1;
        }
      } catch (err) {
        this.logger.warn(`web-push dispatch failed for ${sub.id}: ${(err as Error).message}`);
      }
    }
    return delivered;
  }
}
