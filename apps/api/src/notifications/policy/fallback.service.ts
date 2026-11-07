import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NotificationType, DeliveryState, SendKind } from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from '../../metrics/metrics.service';
import { NotificationService } from '../notification.service';
import { EVENT_POLICY, type FallbackPolicy } from './notification-policy';
import { intentKeyFor } from './dedupe-key';

/** Appended to the original intent key to form the fallback's explicit intent. */
export const FALLBACK_SUFFIX = ':fallback';

/**
 * The intent key the fallback row is STORED under. `enqueue` hashes every explicit intent
 * (`intentKeyFor`: sha256 of type, recipient and subject), so the fallback is NOT stored as
 * `<original>:fallback`; it is the hash of that. The SQL in `due` derives the same value with
 * Postgres's sha256(); the integration suite proves the two agree.
 */
export function fallbackIntentKey(
  type: NotificationType,
  recipientRef: string,
  intentKey: string,
): string {
  return intentKeyFor({
    type,
    recipientRef,
    payload: {},
    explicitIntent: `${intentKey}${FALLBACK_SUFFIX}`,
  })!;
}

export interface FallbackSummary {
  considered: number;
  opened: number;
  /** Sent through the ordinary path, but no fallback row could be created (no number, no consent, channel unavailable). */
  unavailable: number;
}

/*
  How long after the original a fallback is still worth opening. The wait (`afterMinutes`) is
  when it becomes due; this is when trying stops. A day later the customer has been told by
  some other path or has been to the venue, and an intent that could not get a fallback (no
  phone number, no consent, SMS not configured) would otherwise be retried every minute
  forever. A policy may set its own `giveUpAfterMinutes`.
*/
export const DEFAULT_FALLBACK_HORIZON_MINUTES = 24 * 60;

/** Delivery states that mean a preferred channel got through (see `effective`). */
const GOT_THROUGH: string[] = [DeliveryState.DELIVERED, DeliveryState.READ];

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
    const summary: FallbackSummary = { considered: 0, opened: 0, unavailable: 0 };

    for (const { type, fallback } of this.fallbackTypes()) {
      const due = await this.due(type, fallback, now, limit);
      for (const { intentKey, recipientRef } of due) {
        summary.considered += 1;
        // Re-checked one by one: the selection is a snapshot, and a receipt or another worker
        // can have settled the intent since.
        if (await this.opened(type, recipientRef, intentKey)) continue;
        if (await this.effective(intentKey, fallback)) continue;
        if (await this.open(intentKey, type, fallback)) summary.opened += 1;
        else summary.unavailable += 1;
      }
    }

    if (summary.opened > 0) {
      this.logger.warn(`opened ${summary.opened} fallback channel(s) after no effective delivery`);
    }
    return summary;
  }

  /**
   * The intents that still NEED a fallback, oldest first: past the wait, inside the horizon,
   * no fallback yet, and no preferred channel that got through.
   *
   * ── WHY THE DATABASE FILTERS, NOT THE LOOP ─────────────────────────────────────────
   * The batch is bounded (a mass cancellation must not pull the whole backlog into memory).
   * When the filtering happened in the loop, the batch was simply the oldest N preferred-channel
   * intents, and an intent that had been settled -- its email delivered, or its fallback
   * already opened -- stayed in that oldest N for ever. After N cancellations the sweep read
   * the same settled intents every minute and never reached a newer one: a show cancelled for
   * 500 people opened fallbacks for the first 200 and none for the rest. Excluding settled
   * intents here means every sweep's batch is work that is actually outstanding.
   *
   * Oldest first still holds: the person who has waited longest to hear their show is off is
   * exactly who this sweep exists for.
   */
  private async due(
    type: NotificationType,
    fallback: FallbackPolicy,
    now: Date,
    limit: number,
  ): Promise<{ intentKey: string; recipientRef: string }[]> {
    const cutoff = new Date(now.getTime() - fallback.afterMinutes * 60_000);
    const horizon = new Date(
      now.getTime() - (fallback.giveUpAfterMinutes ?? DEFAULT_FALLBACK_HORIZON_MINUTES) * 60_000,
    );
    const satisfiedBy: string[] = [...fallback.satisfiedBy];
    const rows = await this.prisma.$queryRaw<
      { intentKey: string; recipientRef: string }[]
    >(Prisma.sql`
      SELECT n."intentKey", min(COALESCE(n."userId", n."toEmail", '')) AS "recipientRef"
        FROM "Notification" n
       WHERE n."type"::text = ${type}
         AND n."intentKey" IS NOT NULL
         AND n."channel" = ANY(${satisfiedBy}::text[])
         AND n."createdAt" <= ${cutoff}
         AND n."createdAt" >= ${horizon}
         AND NOT EXISTS (
               SELECT 1 FROM "Notification" f
                WHERE f."intentKey" = encode(sha256(convert_to(
                        n."type"::text || ' ' || COALESCE(n."userId", n."toEmail", '') || ' ' ||
                        n."intentKey" || ${FALLBACK_SUFFIX}, 'UTF8')), 'hex'))
         AND NOT EXISTS (
               SELECT 1
                 FROM "NotificationDelivery" d
                 JOIN "Notification" s ON s."id" = d."notificationId"
                WHERE s."intentKey" = n."intentKey"
                  AND s."channel" = ANY(${satisfiedBy}::text[])
                  AND (d."status" = ANY(${GOT_THROUGH}::text[])
                       OR (d."status" = ${DeliveryState.ACCEPTED} AND d."channel" = 'push')))
       GROUP BY n."intentKey"
       ORDER BY min(n."createdAt") ASC
       LIMIT ${limit}`);
    return rows;
  }

  /** Has the fallback already been opened for this intent? */
  private async opened(
    type: NotificationType,
    recipientRef: string,
    intentKey: string,
  ): Promise<boolean> {
    /*
      The fallback is stored under the HASH of the derived intent (`fallbackIntentKey`), never
      the original key. Looking for the original key on the fallback channel -- which is what
      this used to do -- never found it, so every sweep re-sent an existing fallback (the dedupe
      index dropped it) and counted it as opened again.
    */
    const existing = await this.prisma.notification.count({
      where: { intentKey: fallbackIntentKey(type, recipientRef, intentKey) },
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
   *
   * Returns whether a fallback now EXISTS. `send` can rightly write nothing (no phone number,
   * no SMS consent, the channel not configured here); that used to be reported, logged and
   * counted as "opened" every minute.
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
      intentKey: `${intentKey}${FALLBACK_SUFFIX}`,
      // The one caller permitted to reach a channel policy holds back.
      allowDeferredChannel: true,
      // The most expensive message this platform sends, labelled so a cost report can name
      // it rather than burying it in the ordinary total.
      sendReason: SendKind.FALLBACK,
    });
    if (!(await this.opened(type, source.userId ?? source.toEmail ?? '', intentKey))) {
      this.metrics?.recordNotification(fallback.to, 'fallback', 'unavailable');
      return false;
    }
    this.metrics?.recordNotification(fallback.to, 'fallback', 'opened');
    this.metrics?.recordNotificationFallback(type, fallback.to);
    return true;
  }
}
