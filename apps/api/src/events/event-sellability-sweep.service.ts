import { Injectable, Logger } from '@nestjs/common';
import { NotificationType } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AdminAudienceService } from '../notifications/admin-audience.service';
import { EventSellabilityService } from './event-sellability.service';

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
 * The notification's dedupe key is derived from the event and the set of blocker codes, so a
 * problem that persists produces one message and a NEW problem produces another. Sweeping
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
        The blocker codes, sorted, are the identity of the PROBLEM rather than of the check.
        Two sweeps over an unchanged fault produce the same key and the second is discarded by
        the database; a fault that changes produces a new key and a new message, which is the
        one worth reading.
      */
      const signature = [...new Set(report.blockers.map((b) => b.code))].sort().join('+');

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
      const sent = await this.audience.notifyOrganizationOwners(
        event.organizationId,
        NotificationType.EVENT_NOT_SELLABLE,
        {
          eventId: event.id,
          eventTitle: event.title,
          // The sentence the check already produced, not a summary of a code. It names the
          // seat category or the ticket type, which is the part that makes it actionable.
          /*
            One sentence per DISTINCT fault, not one per show. A 148-show event with a single
            misconfigured jurisdiction used to produce the same sentence 148 times in one
            email; the report now folds them, and the count carries what was lost.
          */
          reason: report.blockers
            .map((b) =>
              b.affectedSessions > 1 ? `${b.message} (${b.affectedSessions} shows)` : b.message,
            )
            .join(' '),
          /*
            Part of the notification's identity, via the dedupe table: eventId + blockerCodes.
            A fault that persists produces the same key and the repeat is discarded by the
            database; a DIFFERENT fault produces a new key and a new message.
          */
          blockerCodes: signature,
        },
      );
      summary.notified += sent;
    }
    return summary;
  }
}
