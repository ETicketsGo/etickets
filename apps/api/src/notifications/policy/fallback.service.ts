import { Injectable, Logger } from '@nestjs/common';
import { NotificationType, DeliveryState } from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from '../../metrics/metrics.service';
import { NotificationService } from '../notification.service';
import { EVENT_POLICY, type FallbackPolicy } from './notification-policy';
import type { ChannelKey } from '../channels/notification-channel.interface';

export interface FallbackSummary {
  considered: number;
  opened: number;
}

/**
 * Opening a paid channel because the free ones produced nothing.
 *
 * ── WHY NOT "WHATSAPP FAILED, SEND AN SMS" ─────────────────────────────────────────
 * Because that rule fires every time WhatsApp is merely slow, sends a second message about
 * the same thing, and bills for it. On a cancelled sold-out house that is a few hundred
 * unnecessary SMS, most of them arriving minutes after the WhatsApp message the customer
 * already read.
 *
 * ── THE THREE THINGS THAT MAKE THIS DETERMINISTIC ──────────────────────────────────
 *
 * A WAIT. Thirty minutes, declared per event. Not a guess at network latency — it is how
 * long is acceptable for somebody not to know their show is off, and it is long past the
 * point where a delivery receipt has plainly arrived or plainly is not going to.
 *
 * A DEFINITION OF ENOUGH. The fallback is unnecessary if any preferred channel got through.
 * `satisfiedBy` says which channels count.
 *
 * ONE FALLBACK, EVER. It is created through the ordinary notification path with an intent
 * key derived from the original, so the Phase 1 unique index makes a second sweep, a
 * restarted worker or two workers racing produce nothing. The anti-bombardment guarantee is
 * the same index that guarantees everything else.
 *
 * ── WHAT COUNTS AS THE MESSAGE HAVING GOT THROUGH ──────────────────────────────────
 * Not simply DELIVERED, because push can never say that. Neither FCM nor Web Push has a
 * per-message delivery callback, so treating "no push receipt" as "push failed" would fire
 * an SMS at every customer with the app installed — punishing the channel that works best
 * for being the one that cannot prove it. A push the provider ACCEPTED is an effective path.
 * A push that was SKIPPED, because the person has no registered device, is not.
 */
@Injectable()
export class NotificationFallbackService {
  private readonly logger = new Logger('Notification');

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly metrics?: MetricsService,
  ) {}

  /** Every type whose policy declares a fallback. Today that is a cancelled booking. */
  private fallbackTypes(): { type: NotificationType; fallback: FallbackPolicy }[] {
    return Object.entries(EVENT_POLICY)
      .filter(([, p]) => p?.fallback)
      .map(([type, p]) => ({ type: type as NotificationType, fallback: p!.fallback! }));
  }

  /**
   * One sweep. Finds intents whose wait has elapsed with nothing effective, and opens the
   * fallback channel for each.
   */
  async runDue(now: Date = new Date(), limit = 200): Promise<FallbackSummary> {
    const summary: FallbackSummary = { considered: 0, opened: 0 };

    for (const { type, fallback } of this.fallbackTypes()) {
      const cutoff = new Date(now.getTime() - fallback.afterMinutes * 60_000);
      /*
        Candidates are the PREFERRED-channel rows, not the intents: an intent has no row of
        its own. Bounded per sweep so a mass cancellation cannot pull the whole backlog into
        memory; the rest waits for the next tick and is no less overdue for it.
      */
      const candidates = await this.prisma.notification.findMany({
        where: {
          type,
          intentKey: { not: null },
          createdAt: { lte: cutoff },
          channel: { in: [...fallback.satisfiedBy] },
        },
        select: { intentKey: true },
        distinct: ['intentKey'],
        take: limit,
      });

      for (const candidate of candidates) {
        const intentKey = candidate.intentKey!;
        summary.considered += 1;
        if (await this.opened(intentKey, fallback.to)) continue;
        if (await this.effective(intentKey, fallback)) continue;
        if (await this.open(intentKey, type, fallback)) summary.opened += 1;
      }
    }

    if (summary.opened > 0) {
      this.logger.warn(`opened ${summary.opened} fallback channel(s) after no effective delivery`);
    }
    return summary;
  }

  /** Has the fallback already been opened for this intent? */
  private async opened(intentKey: string, channel: ChannelKey): Promise<boolean> {
    const existing = await this.prisma.notification.count({
      where: { intentKey, channel },
    });
    return existing > 0;
  }

  /**
   * Did any preferred channel get through?
   *
   * A row that is still PENDING has not had its chance yet, and one that FAILED never
   * reached a provider — neither is evidence either way, and the wait is what covers them.
   * What counts is an ATTEMPT that a provider took responsibility for.
   */
  private async effective(intentKey: string, fallback: FallbackPolicy): Promise<boolean> {
    const attempts = await this.prisma.notificationDelivery.findMany({
      where: {
        notification: { intentKey, channel: { in: [...fallback.satisfiedBy] } },
        status: {
          in: [DeliveryState.DELIVERED, DeliveryState.READ, DeliveryState.ACCEPTED],
        },
      },
      select: { status: true, channel: true },
    });

    return attempts.some((a) => {
      if (a.status === DeliveryState.DELIVERED || a.status === DeliveryState.READ) return true;
      /*
        ACCEPTED counts only where the channel CANNOT report delivery. For push that is a
        property of FCM and Web Push, not a gap in this platform, so an accepted push is the
        best evidence that channel will ever produce and treating it as failure would fire an
        SMS at everybody with the app. For WhatsApp and email, which do report, acceptance is
        not enough -- that is the whole distinction Phase 2 drew.
      */
      return a.channel === 'push';
    });
  }

  /**
   * Open the fallback, reusing the payload the original was built from.
   *
   * It goes through `send` like anything else, so it inherits the policy check, the
   * suppression check and the dedupe index. The intent key is derived from the original's,
   * which is what makes a second sweep a no-op.
   */
  private async open(
    intentKey: string,
    type: NotificationType,
    fallback: FallbackPolicy,
  ): Promise<boolean> {
    const source = await this.prisma.notification.findFirst({
      where: { intentKey },
      orderBy: { createdAt: 'asc' },
      select: { userId: true, toEmail: true, payload: true, locale: true },
    });
    if (!source) return false;

    await this.notifications.send({
      type,
      userId: source.userId,
      toEmail: source.toEmail,
      payload: (source.payload as Record<string, unknown>) ?? {},
      // Only the fallback channel. Re-sending the preferred ones is precisely the
      // bombardment this exists to avoid -- and they would be refused by dedupe anyway.
      channels: [fallback.to],
      locale: source.locale,
      // Derived from the original, so exactly one fallback can ever exist for this intent.
      intentKey: `${intentKey}:fallback`,
      // The one caller permitted to reach a channel policy holds back.
      allowDeferredChannel: true,
    });
    this.metrics?.recordNotification(fallback.to, 'fallback', 'opened');
    return true;
  }
}
