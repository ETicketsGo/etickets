import { Injectable, Logger } from '@nestjs/common';
import { BookingStatus, NotificationType, SessionStatus } from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationService } from '../notification.service';

export interface FanoutSummary {
  sessions: number;
  notified: number;
  remaining: number;
}

/**
 * Telling everybody who holds a ticket that the show is off.
 *
 * ── WHY THIS IS NOT A LOOP INSIDE cancelShow ───────────────────────────────────────
 * A sold-out multiplex screen is several hundred bookings, and a festival headliner is
 * several thousand. Sending them from the cancellation request means the organizer watches a
 * spinner for a minute while we talk to four providers per customer, and any one timeout
 * fails the whole request — leaving them unsure whether the show is cancelled at all. The
 * cancellation must succeed or fail on its own merits, and it does: it commits a domain
 * event and returns.
 *
 * ── WHY THERE IS NO CURSOR AND NO JOB STATE ────────────────────────────────────────
 * Because the work describes itself. The question "who still needs telling" is answerable
 * from the data at any moment — the eligible bookings on a cancelled session that have no
 * SHOW_CANCELLED notification yet — so progress is implicit in the rows already written.
 *
 * That makes every hard part free. A worker killed halfway through leaves the remaining
 * bookings still matching the query, so the next tick continues exactly where it stopped. Two
 * workers running at once cannot double-send, because the intent's unique dedupe key decides
 * that in the database rather than in either process. A retried event is a no-op. There is no
 * cursor to lose, no batch state to reconcile, and no new table.
 *
 * ── WHY IT SWEEPS RATHER THAN ONLY REACTING ────────────────────────────────────────
 * The domain-event handler calls this immediately, so a cancellation is acted on at once. The
 * sweep exists because "immediately" is not a guarantee: if the event handler failed, the
 * outbox was disabled, or the process died between commit and dispatch, a sweep that asks the
 * data still finds the customers nobody told. A cancelled show with untold ticket holders is
 * the one failure this platform cannot leave to a retry policy.
 */
@Injectable()
export class ShowCancellationFanoutService {
  private readonly logger = new Logger('Notification');

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Who must be told a show is off: CONFIRMED and PARTIALLY_REFUNDED, and nothing else.
   *
   * ── WHO IS DELIBERATELY EXCLUDED, AND WHY ──────────────────────────────────────────
   * A PENDING_PAYMENT hold is somebody who was in checkout; they have no ticket to lose and
   * the hold expires on its own. A CANCELLED booking is somebody who already walked away. A
   * REFUNDED one has had their money back and holds no seat — telling them their show is off
   * is confusing rather than urgent. A partly refunded booking still has live tickets on it
   * and is very much affected.
   *
   * Getting this wrong is expensive in both directions: too wide and the platform pays to
   * send emergency SMS to people with no stake, too narrow and somebody travels to a dark
   * venue. The rule is written once, in the SQL below, rather than kept in two places that
   * can drift.
   */
  static readonly ELIGIBLE_STATUSES = [
    BookingStatus.CONFIRMED,
    BookingStatus.PARTIALLY_REFUNDED,
  ] as const;

  /**
   * Fan out for one cancelled session, in bounded batches.
   *
   * Returns how many were told and how many are still waiting, so a caller can loop and a
   * sweep can report progress without either of them holding the whole audience in memory.
   */
  async fanOut(
    sessionId: string,
    batchSize = 200,
  ): Promise<{ notified: number; remaining: number }> {
    const session = await this.prisma.eventSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        status: true,
        startsAt: true,
        screen: { select: { cinema: { select: { timezone: true } } } },
        event: {
          select: {
            id: true,
            title: true,
            organizationId: true,
            venue: { select: { timezone: true } },
          },
        },
      },
    });
    /*
      Re-checked at execution, not trusted from the event. A session that was reinstated
      between the cancellation and this sweep must not have its customers told it is off.
    */
    if (!session || session.status !== SessionStatus.CANCELLED) {
      return { notified: 0, remaining: 0 };
    }

    /*
      The bookings still to tell, selected in SQL by the ABSENCE of their notification.

      That NOT EXISTS is the whole resumability mechanism: the rows already written ARE the
      progress marker, so a batch never re-offers somebody who has been told and there is no
      cursor to persist or reconcile after a crash. Deterministic order, so two workers walk
      the same audience the same way.
    */
    const pendingIds = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT b."id"
      FROM "Booking" b
      WHERE b."eventSessionId" = ${sessionId}
        AND b."status" IN ('CONFIRMED', 'PARTIALLY_REFUNDED')
        AND NOT EXISTS (
          SELECT 1 FROM "Notification" n
          WHERE n."bookingId" = b."id" AND n."type" = 'SHOW_CANCELLED'
        )
      ORDER BY b."id" ASC
      LIMIT ${batchSize}
    `;
    if (pendingIds.length === 0) return { notified: 0, remaining: 0 };

    // One query for the batch, not one per booking: the N+1 that would make a 2,000-seat
    // house 2,000 round trips.
    const pending = await this.prisma.booking.findMany({
      where: { id: { in: pendingIds.map((r) => r.id) } },
      orderBy: { id: 'asc' },
      select: { id: true, userId: true, buyerEmail: true, reference: true, organizationId: true },
    });

    const timeZone = session.screen?.cinema?.timezone ?? session.event?.venue?.timezone ?? '';

    let notified = 0;
    for (const booking of pending) {
      /*
        One customer at a time, and one customer's failure never stops the rest. A booking
        with a malformed payload or a database hiccup must not leave the other nine hundred
        untold — and because the query above is the progress marker, a failure here simply
        means this booking is still pending on the next pass.
      */
      try {
        await this.notifications.send({
          type: NotificationType.SHOW_CANCELLED,
          userId: booking.userId,
          toEmail: booking.buyerEmail,
          bookingId: booking.id,
          payload: {
            bookingId: booking.id,
            reference: booking.reference ?? '',
            eventTitle: session.event?.title ?? '',
            startsAt: session.startsAt.toISOString(),
            timeZone,
          },
        });
        notified += 1;
      } catch (err) {
        this.logger.warn(
          `show-cancellation fanout: booking ${booking.id} failed, continuing — ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return { notified, remaining: await this.remaining(sessionId) };
  }

  /**
   * How many eligible bookings on this session still have no cancellation notice.
   *
   * A single SQL count with a NOT EXISTS, rather than reading both sets into memory and
   * subtracting: the whole point of the design is that nothing proportional to the audience
   * is ever materialised.
   */
  private async remaining(sessionId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n
      FROM "Booking" b
      WHERE b."eventSessionId" = ${sessionId}
        AND b."status" IN ('CONFIRMED', 'PARTIALLY_REFUNDED')
        AND NOT EXISTS (
          SELECT 1 FROM "Notification" n
          WHERE n."bookingId" = b."id" AND n."type" = 'SHOW_CANCELLED'
        )
    `;
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * The sweep. Finds cancelled shows with people still to tell, and tells a bounded number.
   *
   * ── WHY IT LOOKS BACK ONLY A LITTLE WAY ────────────────────────────────────────────
   * A window, because "every session ever cancelled" is a table scan that grows forever, and
   * because a cancellation nobody was told about a month ago is not something to fix by
   * surprising those customers now. Seven days is long enough to survive any realistic
   * outage and short enough that the query stays cheap.
   */
  async sweep(opts: { batchSize?: number; lookbackDays?: number; maxSessions?: number } = {}) {
    const lookback = new Date(Date.now() - (opts.lookbackDays ?? 7) * 86_400_000);
    const summary: FanoutSummary = { sessions: 0, notified: 0, remaining: 0 };

    /*
      Sessions with somebody still to tell, found in SQL. Doing this in application code would
      mean loading every recently-cancelled session and its bookings to find the few that are
      incomplete — which is exactly the shape of query that makes a sweep an outage.
    */
    const sessions = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT s."id"
      FROM "EventSession" s
      WHERE s."status" = 'CANCELLED'
        AND s."updatedAt" >= ${lookback}
        AND EXISTS (
          SELECT 1 FROM "Booking" b
          WHERE b."eventSessionId" = s."id"
            AND b."status" IN ('CONFIRMED', 'PARTIALLY_REFUNDED')
            AND NOT EXISTS (
              SELECT 1 FROM "Notification" n
              WHERE n."bookingId" = b."id" AND n."type" = 'SHOW_CANCELLED'
            )
        )
      ORDER BY s."updatedAt" ASC
      LIMIT ${opts.maxSessions ?? 20}
    `;

    for (const s of sessions) {
      const result = await this.fanOut(s.id, opts.batchSize ?? 200);
      summary.sessions += 1;
      summary.notified += result.notified;
      summary.remaining += result.remaining;
    }

    if (summary.notified > 0) {
      this.logger.warn(
        `show cancellation: told ${summary.notified} ticket holder(s) across ` +
          `${summary.sessions} show(s); ${summary.remaining} still to go`,
      );
    }
    return summary;
  }
}
