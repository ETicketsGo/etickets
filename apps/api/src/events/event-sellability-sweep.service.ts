import { Injectable, Logger } from '@nestjs/common';
import { NotificationType } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AdminAudienceService } from '../notifications/admin-audience.service';
import { EventSellabilityService } from './event-sellability.service';
import { causeIdentity, legacyCoverage, MAX_LISTED_SESSIONS } from './sellability-cause';

export interface SellabilitySweepSummary {
  checked: number;
  unsellable: number;
  notified: number;
}

/**
 * Published events that nobody can buy from, and the organizer who does not know yet.
 *
 * ── WHY A SWEEP AND NOT ONLY THE PUBLISH GATE ──────────────────────────────────────
 * The gate stops an unsellable event going live, which is most of the problem and not all of
 * it. Configuration keeps changing after publication: a price is edited above a ceiling, a
 * room is reassigned to a layout with no seats, a rate order takes effect on a listing that
 * was entirely compliant when it went up.
 *
 * The listing stays visible through all of that. The storefront takes people to the seat map,
 * they choose seats, and the sale is refused at the last step — so the first person to notice
 * is a customer, and the organizer's evidence is a booking that did not happen. Nothing about
 * the situation generates a signal on its own.
 *
 * ── WHY IT NOTIFIES ONCE AND NOT EVERY TICK ────────────────────────────────────────
 * The notification's dedupe key is derived from the event and the identity of one root cause
 * (`causeIdentity()`), so a problem that persists produces one message and a NEW problem
 * produces another, without re-announcing the old one beside it. Sweeping
 * every few hours and mailing every time would train the recipient to filter the sender,
 * which costs more than the message is worth — and the one that mattered would be filtered
 * with the rest.
 */
@Injectable()
export class EventSellabilitySweepService {
  private readonly logger = new Logger('EventSellability');

  constructor(
    private readonly prisma: PrismaService,
    private readonly sellability: EventSellabilityService,
    private readonly audience: AdminAudienceService,
  ) {}

  async sweep(now: Date = new Date(), limit = 200): Promise<SellabilitySweepSummary> {
    /*
      Only events with a show still to come. A listing whose last date has passed cannot be
      bought from for reasons that have nothing to do with configuration, and telling an
      organizer their finished event is unsellable is noise that makes the real message
      harder to believe.
    */
    const events = await this.prisma.event.findMany({
      where: {
        status: 'PUBLISHED',
        sessions: { some: { startsAt: { gt: now } } },
      },
      select: { id: true, title: true, organizationId: true },
      orderBy: { publishedAt: 'desc' },
      take: limit,
    });

    const summary: SellabilitySweepSummary = { checked: 0, unsellable: 0, notified: 0 };

    for (const event of events) {
      summary.checked += 1;
      let report;
      try {
        report = await this.sellability.check(event.id, now);
      } catch (err) {
        /*
          One event that cannot be checked must not stop the sweep. A missing relation or a
          policy lookup that throws is a defect worth a log line, and the other hundred and
          ninety-nine events still deserve to be checked.
        */
        this.logger.warn(`could not check event ${event.id}: ${err}`);
        continue;
      }
      if (report.sellable) continue;
      summary.unsellable += 1;

      /*
        ── WHO IS ACTUALLY BEING ASKED TO ACT ──────────────────────────────────────────
        Some of these faults cannot be fixed by the organizer at all: a jurisdiction with no
        pricing policy needs a government order read and a rule written by whoever runs this
        platform. Until now only the organization's owners were told, so the one message that
        went out went to the only people who could do nothing about it, and nobody on the
        platform side learned that a customer-facing event was unsellable.

        The organizer-facing copy says the platform team has been told. This is the line that
        makes that true, so it must stay in step with `regulatoryIssue()`.
      */
      const platformBlockers = report.blockers.filter((b) => b.owner === 'PLATFORM');
      /*
        This copy is still one message per event, keyed on the sorted set of PLATFORM codes,
        exactly as the earlier version wrote it - so its first run after the per-cause change
        produces the same keys and adds nothing. Change its key shape and that stops being
        true: it would need the same reading of older rows the organizer copy has below.
      */
      if (platformBlockers.length > 0) {
        await this.audience.notifyAdmins(NotificationType.EVENT_NOT_SELLABLE, {
          eventId: event.id,
          eventTitle: event.title,
          organizationId: event.organizationId,
          reason: platformBlockers.map((b) => b.message).join(' '),
          affectedSessions: platformBlockers.reduce((n, b) => n + b.affectedSessions, 0),
          blockerCodes: [...new Set(platformBlockers.map((b) => b.code))].sort().join('+'),
        });
      }
      /*
        ── ONE MESSAGE PER ROOT CAUSE, NOT ONE PER EVENT OR PER SHOW ───────────────────
        This used to send one message per event, keyed on the sorted set of blocker codes,
        with every fault joined into one paragraph. Two things went wrong with that shape.

        A fault that PERSISTED was announced again whenever a different one appeared or was
        fixed beside it, because the set changed and so did the key. And the message could
        not say which shows were affected or where to go, so the notification centre had
        nothing to group on and nowhere to link - it listed the same sentence once per
        message, which on a long season read as one row per showtime.

        Each folded blocker is one cause, with its affected shows and its fix path in the
        payload. The dedupe key is the event plus `causeIdentity()`, so a cause that persists
        is discarded by the database on every later run, and a NEW cause is told once.

        ── WHAT THE EARLIER SHAPE ALREADY SAID ─────────────────────────────────────────
        Rows from before this shape carry the code SET as their key, which no cause key can
        equal, so on its first run this would announce every standing fault again. A cause
        whose code an earlier message to the same owner already named is treated as told
        (`legacyAnnouncedCodes()`), and that owner is skipped for it. Read, never rewritten.
      */
      const legacy = await this.legacyCoverage(event.id);
      for (const blocker of report.blockers) {
        summary.notified += await this.audience.notifyOrganizationOwners(
          event.organizationId,
          NotificationType.EVENT_NOT_SELLABLE,
          {
            eventId: event.id,
            eventTitle: event.title,
            // The sentence the check already produced, not a summary of a code. It names the
            // seat category or the ticket type, which is the part that makes it actionable.
            reason:
              blocker.affectedSessions > 1
                ? `${blocker.message} (${blocker.affectedSessions} shows)`
                : blocker.message,
            /*
              Part of the notification's identity, via the dedupe table: eventId +
              blockerCodes. Named for what it held before, so that keys written by the
              earlier version still match where the cause is the same.
            */
            blockerCodes: causeIdentity(blocker),
            blockerCode: blocker.code,
            owner: blocker.owner,
            subject: blocker.subject ?? null,
            fix: blocker.fix,
            fixPath: blocker.fixPath,
            affectedSessions: blocker.affectedSessions,
            sessions: blocker.sessions.slice(0, MAX_LISTED_SESSIONS),
          },
          { skip: (userId) => legacy.get(userId)?.has(blocker.code) ?? false },
        );
      }
    }
    return summary;
  }

  /**
   * Who was already told which codes about this event, by a message of the earlier shape.
   *
   * A cancelled row was never delivered, so it told nobody anything. Rows of the current
   * shape and the platform's own copies are read too, and ignored by `legacyCoverage()`.
   */
  private async legacyCoverage(eventId: string) {
    const rows = await this.prisma.notification.findMany({
      where: {
        type: NotificationType.EVENT_NOT_SELLABLE,
        status: { not: 'CANCELLED' },
        payload: { path: ['eventId'], equals: eventId },
      },
      select: { userId: true, payload: true },
    });
    return legacyCoverage(rows);
  }
}
