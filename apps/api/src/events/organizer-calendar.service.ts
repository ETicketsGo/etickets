import { HttpStatus, Injectable } from '@nestjs/common';
import { EventStatus, Role } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';

/** Who may read the calendar: the same roles that may read an event's sessions one by one. */
const CALENDAR_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER];

/**
 * The widest window one request may ask for. A month view is six weeks (42 days) and the
 * console pads a day each side for venues east and west of UTC; 62 leaves room for that and
 * refuses "everything since 2020" outright.
 */
export const CALENDAR_MAX_SPAN_DAYS = 62;

/**
 * Sessions returned in one response. A busy multiplex runs ~40 shows a day, so a month of
 * one is ~1200; past the limit the response says `truncated` rather than silently stopping.
 */
export const CALENDAR_SESSION_LIMIT = 2000;

export interface OrganizerCalendarSession {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  event: {
    id: string;
    title: string;
    category: string;
    status: string;
    experienceType: string;
  };
  venue: {
    id: string;
    name: string;
    city: string;
    country: string | null;
    timezone: string | null;
  };
  /** The zone of the cinema a seated session's room belongs to; null for general admission. */
  cinemaTimezone: string | null;
  /** Tickets sold and on sale over the session's ticket types; null when it has none. */
  sold: number | null;
  capacity: number | null;
}

/**
 * Every session an organization has in a window of time, for the organizer calendar.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────
 * The events list carries no dates, so the calendar's only other source was one event-detail
 * read per event. For the seeded organizer that is 94 requests per page load, and the global
 * throttle (THROTTLE_LIMIT, 120 a minute in production) answered the second load with 429s -
 * the calendar emptied itself and took every other console page down with it for a minute.
 * One bounded, date-ranged query is the only shape that scales with the window shown rather
 * than with the size of the organizer's history.
 *
 * Read-only, and it returns nothing the event-detail read does not already return to the same
 * roles: no money, no buyers.
 */
@Injectable()
export class OrganizerCalendarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
  ) {}

  async sessions(
    user: RequestUser,
    organizationId: string,
    from: Date,
    to: Date,
  ): Promise<{ sessions: OrganizerCalendarSession[]; truncated: boolean; limit: number }> {
    await this.access.assertMember(user, organizationId, CALENDAR_ROLES);
    if (!(to.getTime() > from.getTime())) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'The end of the window must be after its start.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (to.getTime() - from.getTime() > CALENDAR_MAX_SPAN_DAYS * 86_400_000) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        `Ask for at most ${CALENDAR_MAX_SPAN_DAYS} days at a time.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const rows = await this.prisma.eventSession.findMany({
      where: {
        event: { organizationId, status: { not: EventStatus.ARCHIVED } },
        /*
          Every session that touches the window: one starting inside it, or one that started
          before it and is still running - a three-day festival must appear on its third day.
        */
        OR: [{ startsAt: { gte: from, lt: to } }, { startsAt: { lt: from }, endsAt: { gt: from } }],
      },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      take: CALENDAR_SESSION_LIMIT + 1,
      select: {
        id: true,
        startsAt: true,
        endsAt: true,
        status: true,
        event: {
          select: {
            id: true,
            title: true,
            category: true,
            status: true,
            experienceType: true,
            venue: {
              select: { id: true, name: true, city: true, country: true, timezone: true },
            },
          },
        },
        screen: { select: { cinema: { select: { timezone: true } } } },
        ticketTypes: {
          select: { inventory: { select: { quantityTotal: true, quantitySold: true } } },
        },
      },
    });

    const truncated = rows.length > CALENDAR_SESSION_LIMIT;
    const sessions = rows.slice(0, CALENDAR_SESSION_LIMIT).map((r) => {
      let sold = 0;
      let capacity = 0;
      let counted = false;
      for (const t of r.ticketTypes) {
        if (!t.inventory) continue;
        counted = true;
        sold += t.inventory.quantitySold;
        capacity += t.inventory.quantityTotal;
      }
      const { venue, ...event } = r.event;
      return {
        id: r.id,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        status: r.status,
        event,
        venue,
        cinemaTimezone: r.screen?.cinema?.timezone ?? null,
        sold: counted ? sold : null,
        capacity: counted ? capacity : null,
      };
    });
    return { sessions, truncated, limit: CALENDAR_SESSION_LIMIT };
  }
}
