import { HttpStatus } from '@nestjs/common';
import { z } from 'zod';
import { EventStatus, venueZone } from '@eticketsgo/shared-types';
import { AppException, ErrorCodes } from '../common/errors';
import { countryFilterField, countryWhere } from '../admin/country-filter';
import { dayField, dayRangeWhere, idField } from '../admin/list-filters';
import { spaceTimezone } from '../spaces/space-owner';

/**
 * The admin calendar: every session across every organizer, in a window.
 *
 * ── WHY THIS IS NOT THE EVENT LIST ─────────────────────────────────────────────────
 * `GET /admin/events` answers "which events", one row per event, newest edit first, paged. A
 * calendar asks "what is on, and when", which is one row per SESSION placed on a day - and the
 * day is the day AT THE VENUE. The event list carries neither: it has the first and last start
 * of each event and no zone, so a run of twelve shows would be drawn as one bar, and a show at
 * 00:30 in Sydney would land on the previous day for anybody reading it in Hyderabad. Paging
 * through every event to rebuild the sessions would also make the cost of opening a month grow
 * with the size of the catalogue rather than with the month.
 *
 * So this is a read-only projection of the same rows the moderation queue reads, under the same
 * guard (`EVENT_REVIEW`), with nothing in it that the event list does not already show an admin:
 * no buyer, no booking, no money.
 *
 * ── THE WINDOW ─────────────────────────────────────────────────────────────────────
 * Whole UTC days, inclusive at both ends, through the same `dayField` and window builder the
 * finance filters use, so "1 October" cannot mean a different instant here than on the refund
 * queue. Both ends are REQUIRED and the span is capped: an unbounded calendar is a full-table
 * read that looks like a page. The client asks for a day either side of what it draws, because
 * a venue's local day can start up to fourteen hours away from the UTC one, and places each
 * session by its own zone.
 *
 * ── THE CAP ────────────────────────────────────────────────────────────────────────
 * A busy month across a whole platform can hold more sessions than a page should draw. Rather
 * than silently drop the tail, the response says `truncated` and the console tells the operator
 * to narrow the filters. A calendar that quietly omits shows is worse than one that admits it is
 * full.
 */

/** The longest window one request may ask for, in days. A month view plus padding fits. */
export const CALENDAR_MAX_DAYS = 62;

/** The most sessions one response carries before it says it is truncated. */
export const CALENDAR_LIMIT = 1000;

function daysBetween(from: string, to: string): number {
  return (
    Math.round(
      (new Date(`${to}T00:00:00.000Z`).getTime() - new Date(`${from}T00:00:00.000Z`).getTime()) /
        86_400_000,
    ) + 1
  );
}

export const adminCalendarQuerySchema = z
  .object({
    from: dayField,
    to: dayField,
    country: countryFilterField,
    organizationId: idField,
    status: z.nativeEnum(EventStatus).optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.from || !v.to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [v.from ? 'to' : 'from'],
        message: 'A calendar needs both a start and an end date.',
      });
      return;
    }
    if (v.from > v.to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: 'The end date is before the start date.',
      });
      return;
    }
    if (daysBetween(v.from, v.to) > CALENDAR_MAX_DAYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: `A calendar window can be at most ${CALENDAR_MAX_DAYS} days.`,
      });
    }
  });

export interface AdminCalendarQuery {
  from: string;
  to: string;
  /** ISO alpha-2, already validated by `countryFilterField`. */
  country?: string;
  organizationId?: string;
  status?: EventStatus;
}

/**
 * The Prisma `where` for the sessions in a window.
 *
 * Every filter sits inside `AND` so none can erase another - the country and the event status
 * both reach through `event`, and a spread would let the second overwrite the first.
 */
export function adminCalendarWhere(q: AdminCalendarQuery): Record<string, unknown> {
  const window = dayRangeWhere(q.from, q.to);
  if (!window?.gte || !window.lt) {
    // The schema already refuses this; the service is not the place to discover it again.
    throw new AppException(
      ErrorCodes.VALIDATION_FAILED,
      'A calendar needs both a start and an end date.',
      HttpStatus.BAD_REQUEST,
    );
  }
  const and: Record<string, unknown>[] = [{ startsAt: window }];
  const inCountry = countryWhere('events', q.country);
  if (inCountry) and.push({ event: inCountry });
  if (q.organizationId) and.push({ event: { organizationId: q.organizationId } });
  if (q.status) and.push({ event: { status: q.status } });
  return { AND: and };
}

/** What the query selects. Named, so the response cannot widen by accident. */
export const ADMIN_CALENDAR_SELECT = {
  id: true,
  startsAt: true,
  endsAt: true,
  status: true,
  screen: {
    select: {
      name: true,
      venue: { select: { timezone: true } },
      cinema: { select: { timezone: true } },
    },
  },
  event: {
    select: {
      id: true,
      title: true,
      status: true,
      category: true,
      organization: { select: { id: true, name: true } },
      venue: { select: { name: true, city: true, country: true, timezone: true } },
    },
  },
} as const;

export interface AdminCalendarDbRow {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  screen: {
    name: string;
    venue: { timezone: string | null } | null;
    cinema: { timezone: string | null } | null;
  } | null;
  event: {
    id: string;
    title: string;
    status: string;
    category: string;
    organization: { id: string; name: string };
    venue: { name: string; city: string; country: string | null; timezone: string | null };
  };
}

export interface AdminCalendarSession {
  id: string;
  startsAt: string;
  endsAt: string;
  status: string;
  /**
   * The IANA zone the session's local day and time are read in, or null when nothing says.
   *
   * The event's venue first, as every other screen reads it (tickets, check-in, the public
   * page); then the room's own place for a session in a room whose venue was never given a zone.
   * Null is returned as null and never replaced with the launch market's zone - the console
   * shows such a session in UTC and says so.
   */
  timezone: string | null;
  room: string | null;
  event: { id: string; title: string; status: string; category: string };
  organization: { id: string; name: string };
  venue: { name: string; city: string; country: string | null };
}

export function adminCalendarRow(row: AdminCalendarDbRow): AdminCalendarSession {
  const zone =
    venueZone(row.event.venue.timezone, row.event.venue.country) ??
    (row.screen ? spaceTimezone(row.screen) : null);
  return {
    id: row.id,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    status: row.status,
    timezone: zone,
    room: row.screen?.name ?? null,
    event: {
      id: row.event.id,
      title: row.event.title,
      status: row.event.status,
      category: row.event.category,
    },
    organization: { id: row.event.organization.id, name: row.event.organization.name },
    venue: {
      name: row.event.venue.name,
      city: row.event.venue.city,
      country: row.event.venue.country,
    },
  };
}
