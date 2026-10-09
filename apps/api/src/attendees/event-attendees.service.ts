import { HttpStatus, Injectable } from '@nestjs/common';
import { isReservedEmail, Role } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import { CSV_BOM, csvLine, type CsvValue } from '../common/csv';
import type { RequestUser } from '../common/decorators';
import {
  afterCursorSql,
  ATTENDEE_ORDER,
  ATTENDEE_STATES,
  attendeeRowsSql,
  attendeeWhereSql,
  type AttendeeCursor,
  type AttendeeDbRow,
  type AttendeeFilter,
  type AttendeeState,
} from './event-attendees.query';

/*
  ── WHO MAY SEE THE LIST, AND WHO MAY TAKE IT AWAY ───────────────────────────────────
  Gate staff (CHECKIN_STAFF) may READ the list: the door has to find "the Sharma booking" when
  a phone has died, which is why the check-in page's lookup calls this endpoint at all. It
  refused them until now, so that lookup only ever worked for owners and managers.

  What staff get is what the door needs and nothing more: names, booking reference, ticket,
  seat, session and check-in. No email, no phone and no payment state - the same line the
  counter search (`checkins.findBookings`) draws - and their search does not match on email,
  which would otherwise let them confirm an address they cannot see.

  Exporting is owners and managers only. A file leaves the system, is forwarded and is kept;
  it is a different act from glancing at a screen, and it is audited.
*/
const VIEW_ROLES: Role[] = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER, Role.CHECKIN_STAFF];
const EXPORT_ROLES: Role[] = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER];

/** Rows per database round trip while exporting: small enough to stream, large enough to be quick. */
export const EXPORT_CHUNK = 1000;

export const ATTENDEE_STATE_LABELS: Record<AttendeeState, string> = {
  CONFIRMED: 'Confirmed',
  PENDING: 'Reserved, not paid',
  CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded',
};

/** Plain-English payment states, for the CSV. Codes the screen also receives as-is. */
const PAYMENT_LABELS: Record<string, string> = {
  SUCCEEDED: 'Paid',
  REFUNDED: 'Refunded',
  PARTIALLY_REFUNDED: 'Partly refunded',
  REQUIRES_PAYMENT: 'Not paid',
  PROCESSING: 'Processing',
  AUTHORIZED: 'Authorised, not captured',
  FAILED: 'Failed',
  VOIDED: 'Voided',
  CASH_DUE: 'Cash, not yet paid',
  CASH_PAID: 'Cash, paid',
  NONE: 'No payment',
};

interface ViewContext {
  eventId: string;
  organizationId: string;
  slug: string;
  isFree: boolean;
  /** Owners, managers and platform admins. Gate staff see names, never contact or money. */
  canSeeContact: boolean;
  canExport: boolean;
  /** Each session's zone: its cinema's when it is in one, else the event venue's. */
  zones: Map<string, string>;
}

function paginate(page: number, pageSize: number, total: number) {
  return { page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}

/** A zone Intl accepts, else UTC - one bad venue setting must not take the list down. */
function safeZone(zone: string | null | undefined): string {
  if (!zone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return zone;
  } catch {
    return 'UTC';
  }
}

/** "2026-10-12 19:30" in the given zone: sortable in a spreadsheet, and unambiguous. */
export function localDateTime(at: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/** "Mon 12 Oct 2026, 19:30" in the given zone, for the screen. */
function readableDateTime(at: Date, zone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(at);
}

/** The payment code for one row, or null where payment does not apply (a free event). */
export function paymentCode(row: AttendeeDbRow, isFree: boolean): string | null {
  if (isFree) return null;
  if (row.paymentMethod === 'CASH') return row.cashCollected ? 'CASH_PAID' : 'CASH_DUE';
  return row.paymentStatus ?? 'NONE';
}

/** An address the organizer may be shown: never a phone-only account's placeholder. */
function shownEmail(email: string | null): string | null {
  return email && !isReservedEmail(email) ? email : null;
}

/** The CSV columns, in order. Payment is dropped for a free event, where it has no meaning. */
export function attendeeCsvHeaders(isFree: boolean): string[] {
  return [
    'Booking reference',
    'Booked at',
    'Buyer name',
    'Buyer email',
    'Attendee name',
    'Attendee email',
    'Attendee phone',
    'Ticket type',
    'Quantity',
    'Session',
    'Time zone',
    'Seat',
    'Ticket serial',
    'Check-in',
    'Checked in at',
    'Booking status',
    ...(isFree ? [] : ['Payment']),
  ];
}

export function attendeeCsvRow(row: AttendeeDbRow, zone: string, isFree: boolean): CsvValue[] {
  const payment = paymentCode(row, isFree);
  return [
    row.reference ?? '',
    localDateTime(row.bookedAt, zone),
    row.buyerName,
    shownEmail(row.buyerEmail),
    row.holderName,
    shownEmail(row.holderEmail),
    row.attendeePhone,
    row.ticketType,
    row.quantity,
    localDateTime(row.sessionStartsAt, zone),
    zone,
    row.seatLabel,
    row.serial,
    row.ticketId ? (row.checkedIn ? 'Checked in' : 'Not checked in') : 'No ticket yet',
    row.checkedInAt ? localDateTime(row.checkedInAt, zone) : '',
    ATTENDEE_STATE_LABELS[row.state],
    ...(isFree ? [] : [PAYMENT_LABELS[payment ?? 'NONE'] ?? payment]),
  ];
}

/**
 * The organizer's attendee list and its CSV export (see `event-attendees.query.ts`).
 *
 * Read-only. It reads bookings, tickets and payments and changes none of them.
 */
@Injectable()
export class EventAttendeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Loads the event and decides what this caller may see.
   *
   * A missing event is a 404 and another organization's event is a 403 (TENANT_FORBIDDEN),
   * the same answers every sibling route under /events/:id gives through `loadOwnedEvent`.
   */
  private async context(user: RequestUser, eventId: string, roles: Role[]): Promise<ViewContext> {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        organizationId: true,
        slug: true,
        isFree: true,
        venue: { select: { timezone: true } },
        sessions: {
          select: { id: true, screen: { select: { cinema: { select: { timezone: true } } } } },
        },
      },
    });
    if (!event) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Event not found.', HttpStatus.NOT_FOUND);
    }
    await this.access.assertMember(user, event.organizationId, roles);

    let manager = this.access.isPlatformAdmin(user);
    if (!manager) {
      const membership = await this.prisma.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId: event.organizationId, userId: user.id } },
        select: { role: true },
      });
      manager = EXPORT_ROLES.includes(membership?.role as Role);
    }

    const zones = new Map<string, string>();
    for (const s of event.sessions) {
      zones.set(s.id, safeZone(s.screen?.cinema?.timezone ?? event.venue?.timezone));
    }
    return {
      eventId: event.id,
      organizationId: event.organizationId,
      slug: event.slug,
      isFree: event.isFree,
      canSeeContact: manager,
      canExport: manager,
      zones,
    };
  }

  private zoneOf(ctx: ViewContext, sessionId: string): string {
    return ctx.zones.get(sessionId) ?? 'UTC';
  }

  /** One page of the list, with totals for the current filter and the choices to filter by. */
  async list(
    user: RequestUser,
    eventId: string,
    filter: AttendeeFilter,
    page: number,
    pageSize: number,
  ) {
    const ctx = await this.context(user, eventId, VIEW_ROLES);
    const rowsSql = attendeeRowsSql(eventId);
    const where = attendeeWhereSql(filter, { searchEmails: ctx.canSeeContact });
    /*
      Per-status totals are counted under every filter EXCEPT status, so the status chips can
      say "Refunded 3" while "Confirmed" is the one selected. `meta.total` is the count under
      the full filter, and is the sum of the matching state(s) - the same rows the page shows.
    */
    const totalsWhere = attendeeWhereSql(filter, {
      searchEmails: ctx.canSeeContact,
      ignoreStatus: true,
    });

    const [rows, grouped, sessions, ticketTypes] = await Promise.all([
      this.prisma.$queryRaw<AttendeeDbRow[]>`${rowsSql}
        SELECT * FROM attendee_rows ${where} ${ATTENDEE_ORDER}
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      this.prisma.$queryRaw<
        { state: AttendeeState; rows: number; tickets: number; checkedIn: number }[]
      >`${rowsSql}
        SELECT "state", count(*)::int AS "rows", coalesce(sum("quantity"), 0)::int AS "tickets",
               (count(*) FILTER (WHERE "checkedIn"))::int AS "checkedIn"
        FROM attendee_rows ${totalsWhere} GROUP BY "state"`,
      this.prisma.eventSession.findMany({
        where: { eventId },
        orderBy: { startsAt: 'asc' },
        select: { id: true, startsAt: true },
      }),
      this.prisma.ticketType.findMany({
        where: { eventSession: { eventId } },
        orderBy: [{ eventSession: { startsAt: 'asc' } }, { name: 'asc' }],
        select: { id: true, name: true, eventSessionId: true },
      }),
    ]);

    const byStatus = Object.fromEntries(
      ATTENDEE_STATES.map((s) => {
        const g = grouped.find((x) => x.state === s);
        return [s, { rows: g?.rows ?? 0, tickets: g?.tickets ?? 0, checkedIn: g?.checkedIn ?? 0 }];
      }),
    ) as Record<AttendeeState, { rows: number; tickets: number; checkedIn: number }>;
    const inFilter = ATTENDEE_STATES.filter((s) => !filter.status || s === filter.status);
    const sum = (key: 'rows' | 'tickets' | 'checkedIn') =>
      inFilter.reduce((n, s) => n + byStatus[s][key], 0);
    const total = sum('rows');

    return {
      data: rows.map((r) => this.present(ctx, r)),
      meta: paginate(page, pageSize, total),
      totals: { rows: total, tickets: sum('tickets'), checkedIn: sum('checkedIn'), byStatus },
      filters: {
        sessions: sessions.map((s) => {
          const zone = this.zoneOf(ctx, s.id);
          return {
            id: s.id,
            startsAt: s.startsAt,
            label: readableDateTime(s.startsAt, zone),
            timeZone: zone,
          };
        }),
        ticketTypes: ticketTypes.map((t) => ({
          id: t.id,
          name: t.name,
          sessionId: t.eventSessionId,
        })),
      },
      event: { isFree: ctx.isFree },
      viewer: { canSeeContact: ctx.canSeeContact, canExport: ctx.canExport },
    };
  }

  private present(ctx: ViewContext, r: AttendeeDbRow) {
    const zone = this.zoneOf(ctx, r.sessionId);
    const contact = ctx.canSeeContact;
    return {
      id: r.rowId,
      ticketId: r.ticketId,
      serial: r.serial,
      bookingId: r.bookingId,
      reference: r.reference,
      bookedAt: r.bookedAt,
      buyerName: r.buyerName,
      buyerEmail: contact ? shownEmail(r.buyerEmail) : null,
      attendeeName: r.holderName,
      attendeeEmail: contact ? shownEmail(r.holderEmail) : null,
      attendeePhone: contact ? r.attendeePhone : null,
      ticketTypeId: r.ticketTypeId,
      ticketType: r.ticketType,
      quantity: r.quantity,
      sessionId: r.sessionId,
      sessionStartsAt: r.sessionStartsAt,
      sessionLabel: readableDateTime(r.sessionStartsAt, zone),
      timeZone: zone,
      seatLabel: r.seatLabel,
      checkedIn: r.checkedIn,
      checkedInAt: r.checkedInAt,
      status: r.state,
      ticketStatus: r.ticketStatus,
      bookingStatus: r.bookingStatus,
      payment: contact ? paymentCode(r, ctx.isFree) : null,
    };
  }

  /** Authorizes an export before a single byte is written, so a refusal is a real 403/404. */
  async authorizeExport(user: RequestUser, eventId: string): Promise<ViewContext> {
    return this.context(user, eventId, EXPORT_ROLES);
  }

  /** The download's name: the event's slug and today's date, nothing a person typed. */
  exportFilename(ctx: ViewContext): string {
    const safe = ctx.slug.replace(/[^a-z0-9-]/gi, '').slice(0, 60) || ctx.eventId;
    return `attendees-${safe}-${new Date().toISOString().slice(0, 10)}.csv`;
  }

  /**
   * Writes the whole filtered list as CSV, a chunk at a time, and audits it.
   *
   * Keyset-paged (`afterCursorSql`) so ten thousand rows cost ten small queries rather than
   * one result set held in memory, and `write` is awaited so a slow client applies
   * backpressure instead of the server buffering the file. Returns the number of rows.
   *
   * The audit records the filter and the count, never a row: an audit log full of names and
   * addresses would itself be a copy of the export. The search TEXT is left out for the same
   * reason - it is usually somebody's name - and only whether there was one is kept.
   */
  async writeExport(
    user: RequestUser,
    ctx: ViewContext,
    filter: AttendeeFilter,
    write: (chunk: string) => Promise<void>,
  ): Promise<number> {
    const rowsSql = attendeeRowsSql(ctx.eventId);
    const where = attendeeWhereSql(filter, { searchEmails: true });
    let count = 0;
    let completed = false;
    try {
      await write(CSV_BOM + csvLine(attendeeCsvHeaders(ctx.isFree)));
      let cursor: AttendeeCursor | null = null;
      for (;;) {
        const chunk: AttendeeDbRow[] = await this.prisma.$queryRaw<AttendeeDbRow[]>`${rowsSql}
          SELECT * FROM attendee_rows ${where} ${afterCursorSql(cursor)} ${ATTENDEE_ORDER}
          LIMIT ${EXPORT_CHUNK}`;
        if (chunk.length === 0) break;
        let text = '';
        for (const r of chunk) {
          text += csvLine(attendeeCsvRow(r, this.zoneOf(ctx, r.sessionId), ctx.isFree));
        }
        await write(text);
        count += chunk.length;
        const last = chunk[chunk.length - 1];
        cursor = { bookedAt: last.bookedAt, bookingId: last.bookingId, rowId: last.rowId };
        if (chunk.length < EXPORT_CHUNK) break;
      }
      completed = true;
      return count;
    } finally {
      await this.audit.record({
        actorUserId: user.id,
        organizationId: ctx.organizationId,
        action: 'ATTENDEES_EXPORTED',
        entityType: 'Event',
        entityId: ctx.eventId,
        metadata: {
          format: 'csv',
          rowCount: count,
          completed,
          filter: {
            sessionId: filter.sessionId ?? null,
            ticketTypeId: filter.ticketTypeId ?? null,
            status: filter.status ?? null,
            checkIn: filter.checkIn ?? null,
            search: Boolean(filter.q?.trim()),
          },
        },
      });
    }
  }
}
