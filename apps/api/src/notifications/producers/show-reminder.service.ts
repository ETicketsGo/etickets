import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BookingStatus, NotificationType, SessionStatus } from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationService } from '../notification.service';

export interface ReminderSummary {
  shows: number;
  reminded: number;
}

/**
 * Reminding people about a show they have tickets for.
 *
 * ── WHY THE WINDOW IS AN INSTANT AND NOT A LOCAL TIME ──────────────────────────────
 * "Twenty-four hours before" is a duration, and a duration before an instant is another
 * instant — so no timezone arithmetic is needed, and none is done. `EventSession.startsAt` is
 * stored as an absolute moment; subtract twenty-four hours and that is when to send.
 *
 * That is not a shortcut, it is the correct answer, and it is correct through daylight saving
 * precisely because it never converts to a local calendar. A Sydney show at 19:00 local on the
 * day the clocks change is one specific instant, and the reminder is twenty-four hours before
 * that instant, whatever either local clock did in between. Computing "the same time
 * yesterday" in local terms is what produces a reminder an hour early twice a year.
 *
 * The RENDERING is a different matter and does convert: the message says when the show starts
 * in the cinema's own zone, because a customer in Kolkata reading about a Kolkata show wants
 * IST and not UTC. That conversion belongs to the template, and it already happens there.
 *
 * ── WHY ELIGIBILITY IS CHECKED WHEN IT FIRES, NOT WHEN IT IS PLANNED ───────────────
 * A day is a long time. Between planning a reminder and sending it, the show can be
 * cancelled, the booking refunded, or the customer can have cancelled it themselves — and a
 * reminder for a show that is off is worse than no reminder at all, because the customer now
 * believes it is on. So nothing is scheduled ahead: the sweep asks, at the moment it would
 * send, whether the booking and the show are still real.
 *
 * ── WHY IT CANNOT SEND TWICE ───────────────────────────────────────────────────────
 * The dedupe key for a reminder is the booking and the window it belongs to, so a worker
 * restart, an overlapping tick, or two workers running at once produce one message between
 * them — decided in the database, not in any process.
 */
@Injectable()
export class ShowReminderService {
  private readonly logger = new Logger('Notification');

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly config?: ConfigService,
  ) {}

  /**
   * How far ahead of the show to remind, in hours.
   *
   * Configuration rather than a constant: a cinema chain reminding people the evening before
   * and a festival reminding them a week before are both reasonable, and neither should be a
   * deploy. One wave only — additional timings are a product decision about how often it is
   * acceptable to message somebody, not a setting to leave switched on by default.
   */
  private get leadHours(): number {
    const configured = Number(this.config?.get('NOTIFICATION_REMINDER_LEAD_HOURS') ?? 24);
    return Number.isFinite(configured) && configured > 0 ? configured : 24;
  }

  /**
   * Whether reminders are sent at all.
   *
   * OFF by default. Turning this on starts messaging every ticket holder on the platform
   * about every future show, and that is a product launch rather than a deployment — it needs
   * somebody to have decided the copy is right and the volume is wanted.
   */
  private get enabled(): boolean {
    return this.config?.get<string>('NOTIFICATION_REMINDERS_ENABLED') === 'true';
  }

  /**
   * One sweep: find shows entering their reminder window, and tell whoever still holds a
   * valid booking for them.
   *
   * `toleranceMinutes` is the width of the window this tick considers. It must be at least as
   * long as the interval between ticks, or a show whose exact moment fell between two runs is
   * never reminded about at all — and it can be generous, because the dedupe key means a show
   * caught by two consecutive ticks is still only one message.
   */
  async runDue(
    now: Date = new Date(),
    opts: { toleranceMinutes?: number; maxShows?: number; batchSize?: number } = {},
  ): Promise<ReminderSummary> {
    const summary: ReminderSummary = { shows: 0, reminded: 0 };
    if (!this.enabled) return summary;

    const tolerance = (opts.toleranceMinutes ?? 90) * 60_000;
    const target = now.getTime() + this.leadHours * 3_600_000;
    const from = new Date(target - tolerance);
    const to = new Date(target + tolerance);

    const sessions = await this.prisma.eventSession.findMany({
      where: {
        // SCHEDULED only. A cancelled or paused show must never be reminded about, and a
        // show already under way is not something to remind anybody of.
        status: SessionStatus.SCHEDULED,
        startsAt: { gte: from, lte: to },
      },
      orderBy: { startsAt: 'asc' },
      take: opts.maxShows ?? 50,
      select: {
        id: true,
        startsAt: true,
        screen: { select: { cinema: { select: { timezone: true } } } },
        event: { select: { title: true, venue: { select: { timezone: true } } } },
      },
    });

    for (const session of sessions) {
      summary.shows += 1;
      summary.reminded += await this.remindOne(session, opts.batchSize ?? 200);
    }

    if (summary.reminded > 0) {
      this.logger.log(`reminded ${summary.reminded} booking(s) across ${summary.shows} show(s)`);
    }
    return summary;
  }

  private async remindOne(
    session: {
      id: string;
      startsAt: Date;
      screen: { cinema: { timezone: string | null } | null } | null;
      event: { title: string | null; venue: { timezone: string | null } | null } | null;
    },
    batchSize: number,
  ): Promise<number> {
    /*
      Live bookings only, and checked NOW rather than a day ago. Selected in SQL by the
      absence of their reminder, so a restarted worker resumes exactly where it stopped and a
      batch never re-offers somebody already told — the same self-describing progress the
      cancellation fan-out uses.
    */
    const pending = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT b."id"
      FROM "Booking" b
      WHERE b."eventSessionId" = ${session.id}
        AND b."status" IN ('CONFIRMED', 'PARTIALLY_REFUNDED')
        AND NOT EXISTS (
          SELECT 1 FROM "Notification" n
          WHERE n."bookingId" = b."id" AND n."type" = 'EVENT_REMINDER'
        )
      ORDER BY b."id" ASC
      LIMIT ${batchSize}
    `;
    if (pending.length === 0) return 0;

    const bookings = await this.prisma.booking.findMany({
      where: { id: { in: pending.map((r) => r.id) } },
      orderBy: { id: 'asc' },
      select: { id: true, userId: true, buyerEmail: true, reference: true, status: true },
    });

    const timeZone = session.screen?.cinema?.timezone ?? session.event?.venue?.timezone ?? '';
    let sent = 0;

    for (const booking of bookings) {
      // Belt and braces: the SQL above already filtered on status, but a refund committed
      // between the two queries would otherwise earn somebody a reminder for a show they no
      // longer have a ticket to.
      if (
        booking.status !== BookingStatus.CONFIRMED &&
        booking.status !== BookingStatus.PARTIALLY_REFUNDED
      ) {
        continue;
      }
      try {
        await this.notifications.send({
          type: NotificationType.EVENT_REMINDER,
          userId: booking.userId,
          toEmail: booking.buyerEmail,
          bookingId: booking.id,
          payload: {
            bookingId: booking.id,
            reference: booking.reference ?? '',
            eventName: session.event?.title ?? '',
            startsAt: session.startsAt.toISOString(),
            timeZone,
          },
          /*
            The booking and the show's start instant. Two reminder waves for the same show
            would need different windows in the key; today there is one, and a show that is
            rescheduled has a different `startsAt` and is legitimately a different reminder.
          */
          intentKey: `reminder:${booking.id}:${session.startsAt.toISOString()}`,
        });
        sent += 1;
      } catch (err) {
        // One customer's failure never stops the rest, and the query above means they are
        // simply still pending next tick.
        this.logger.warn(
          `reminder for booking ${booking.id} failed, continuing — ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return sent;
  }
}
