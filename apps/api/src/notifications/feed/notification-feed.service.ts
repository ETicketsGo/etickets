import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EventSellabilityService } from '../../events/event-sellability.service';
import { causeIdentity } from '../../events/sellability-cause';
import { NotificationService } from '../notification.service';
import { NotificationTemplateService } from '../templates/notification-template.service';
import { typesForAudience, type MessageAudience } from '../message-class';
import {
  groupNotifications,
  sectionFeed,
  type EventResolution,
  type FeedSection,
  type FeedSourceRow,
} from './notification-feed';

/**
 * How many stored notifications one read folds.
 *
 * More than the flat inbox's fifty, because folding is the point: fifty rows that are one
 * fault each about a show would otherwise be a single card and nothing else.
 */
const FEED_ROWS = 200;

/**
 * How many events have their sellability checked live per read.
 *
 * Each check prices every show of the event against its policy, which is real work on a long
 * season. The newest few are what the organizer is looking at; anything past them is shown as
 * still a problem rather than guessed fixed.
 */
const LIVE_CHECKS = 5;

export interface NotificationFeed {
  sections: FeedSection[];
  unreadCount: number;
  /** Rows folded into this answer, and whether older ones exist beyond them. */
  scanned: number;
  truncated: boolean;
}

@Injectable()
export class NotificationFeedService {
  private readonly logger = new Logger('NotificationFeed');

  constructor(
    private readonly prisma: PrismaService,
    private readonly templates: NotificationTemplateService,
    private readonly notifications: NotificationService,
    private readonly sellability: EventSellabilityService,
  ) {}

  async feed(userId: string, audience?: MessageAudience): Promise<NotificationFeed> {
    const where = {
      userId,
      channel: 'in_app',
      status: 'SENT',
      ...(audience ? { type: { in: typesForAudience(audience) } } : {}),
    };
    const rows = await this.prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: FEED_ROWS + 1,
    });
    const truncated = rows.length > FEED_ROWS;
    const kept = rows.slice(0, FEED_ROWS);

    const source: FeedSourceRow[] = kept.map((row) => {
      const payload = (row.payload as Record<string, unknown>) ?? {};
      const { subject, body } = this.templates.render(row.type, row.locale, payload);
      return {
        id: row.id,
        type: row.type,
        payload,
        subject,
        body,
        readAt: row.readAt,
        createdAt: row.createdAt,
        templated: this.templates.hasTemplate(row.type),
      };
    });

    const live = await this.liveResolutions(source);
    const groups = groupNotifications(source, (eventId) => live.get(eventId));
    return {
      sections: sectionFeed(groups),
      unreadCount: await this.notifications.unreadCount(userId, audience),
      scanned: kept.length,
      truncated,
    };
  }

  /**
   * Mark several of the reader's own notifications read at once: what "mark read" and
   * "dismiss" do to a card that folds many rows.
   *
   * Scoped to the reader and the in-app channel exactly as the single version is, so an id
   * belonging to somebody else - or to an email row - is ignored rather than refused. The
   * answer is how many changed, which a caller can compare with how many it sent.
   */
  async markManyRead(userId: string, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const res = await this.prisma.notification.updateMany({
      where: { id: { in: ids }, userId, channel: 'in_app', readAt: null },
      data: { readAt: new Date() },
    });
    return res.count;
  }

  /**
   * Whether each unsellable event in view is still unsellable, and for which causes.
   *
   * Read from the same check the sweep and the publish gate use, so the notification centre
   * cannot call something fixed that the checkout would still refuse. An event that is no
   * longer published, or has no show still to come, cannot be bought from for reasons the
   * notification is not about - its warning has nothing left to warn of.
   */
  private async liveResolutions(rows: FeedSourceRow[]): Promise<Map<string, EventResolution>> {
    const eventIds: string[] = [];
    for (const row of rows) {
      if (row.type !== 'EVENT_NOT_SELLABLE') continue;
      const id = row.payload.eventId;
      if (typeof id === 'string' && !eventIds.includes(id)) eventIds.push(id);
      if (eventIds.length >= LIVE_CHECKS) break;
    }
    const out = new Map<string, EventResolution>();
    const now = new Date();
    await Promise.all(
      eventIds.map(async (eventId) => {
        try {
          const event = await this.prisma.event.findUnique({
            where: { id: eventId },
            select: {
              status: true,
              sessions: { where: { startsAt: { gt: now } }, select: { id: true }, take: 1 },
            },
          });
          if (!event || event.status !== 'PUBLISHED' || event.sessions.length === 0) {
            out.set(eventId, { clear: true, causes: new Set(), codes: new Set() });
            return;
          }
          const report = await this.sellability.check(eventId, now);
          out.set(eventId, {
            clear: report.sellable,
            causes: new Set(report.blockers.map(causeIdentity)),
            codes: new Set(report.blockers.map((b) => b.code)),
          });
        } catch (err) {
          /*
            Unknown, not fixed. A failed check leaves the card where it was, saying the problem
            is still there - telling somebody a fault is gone when we could not look is the
            worse of the two mistakes.
          */
          this.logger.warn(`could not check event ${eventId}: ${err}`);
        }
      }),
    );
    return out;
  }
}
