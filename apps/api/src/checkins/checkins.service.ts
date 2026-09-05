import { HttpStatus, Injectable } from '@nestjs/common';
import { CheckInResult, NotificationType, Role, TicketStatus } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { QrService } from '../tickets/qr.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';
import { MetricsService } from '../metrics/metrics.service';

const STAFF_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER, Role.CHECKIN_STAFF];

export interface CheckInOutcome {
  result: CheckInResult;
  message: string;
  ticket?: {
    id: string;
    serial: string;
    holderName: string | null;
    ticketType: string;
    status: string;
    // Identity/context so gate staff always see the latest attendee + booking.
    reference: string | null;
    seatLabel: string | null;
  };
}

@Injectable()
export class CheckinsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly qr: QrService,
    private readonly access: OrgAccessService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Validates a scanned QR token and checks the holder in. Returns a clear
   * outcome for every state: success, duplicate, invalid, cancelled, wrong-session.
   */
  async scan(
    staff: RequestUser,
    token: string,
    opts: { expectedSessionId?: string; deviceInfo?: string },
  ): Promise<CheckInOutcome> {
    let payload;
    try {
      payload = this.qr.verify(token);
    } catch {
      return this.withScanMetric({
        result: CheckInResult.INVALID,
        message: 'Invalid or unverifiable ticket code.',
      });
    }

    const ticket = await this.prisma.ticket.findUnique({
      where: { id: payload.ticketId },
      include: {
        ticketType: { select: { name: true } },
        booking: { select: { reference: true } },
      },
    });
    // A rotated nonce (attendee transfer/unassign) invalidates the old QR here.
    if (!ticket || ticket.nonce !== payload.nonce) {
      return this.withScanMetric({ result: CheckInResult.INVALID, message: 'Ticket not found.' });
    }

    // Staff must belong to the ticket's organization.
    await this.access.assertMember(staff, ticket.organizationId, STAFF_ROLES);

    return this.admit(ticket, staff, { ...opts, method: 'SCAN' });
  }

  /**
   * Everything that decides whether an identified ticket may be admitted.
   *
   * ── WHY THIS IS SHARED ─────────────────────────────────────────────────────────────
   * A scan and a visual check differ only in HOW the ticket was found. Whether it may be
   * admitted — cancelled, refunded, wrong session, already used, admitted by another cinema's
   * system — is the same question with the same answer, and two implementations of it is how
   * one quietly starts admitting something the other refuses.
   *
   * `method` is carried through to the log rather than changing any decision here. The rules
   * do not care how the ticket was identified; the RECORD does.
   */
  private async admit(
    ticket: {
      id: string;
      serial: string;
      holderName: string | null;
      holderEmail: string | null;
      status: string;
      seatLabel: string | null;
      nonce: string;
      eventSessionId: string;
      organizationId: string;
      vendorBarcode: string | null;
      vendorName: string | null;
      ticketType: { name: string };
      booking: { reference: string | null };
    },
    staff: RequestUser,
    opts: { expectedSessionId?: string; deviceInfo?: string; method: 'SCAN' | 'VISUAL' },
  ): Promise<CheckInOutcome> {
    const scanned = opts.method === 'SCAN';
    /** A scan metric is only meaningful for a scan; a visual admission was never scanned. */
    const done = (o: CheckInOutcome) => (scanned ? this.withScanMetric(o) : o);
    const summary = {
      id: ticket.id,
      serial: ticket.serial,
      holderName: ticket.holderName,
      ticketType: ticket.ticketType.name,
      status: ticket.status,
      reference: ticket.booking.reference,
      seatLabel: ticket.seatLabel,
    };

    if (opts.expectedSessionId && opts.expectedSessionId !== ticket.eventSessionId) {
      await this.log(
        ticket.id,
        ticket.eventSessionId,
        CheckInResult.WRONG_SESSION,
        staff.id,
        opts.deviceInfo,
        opts.method,
      );
      return done({
        result: CheckInResult.WRONG_SESSION,
        message: 'This ticket is for a different session.',
        ticket: summary,
      });
    }

    const deadStatuses: TicketStatus[] = [
      TicketStatus.CANCELLED,
      TicketStatus.REFUNDED,
      TicketStatus.VOID,
    ];
    if (deadStatuses.includes(ticket.status as TicketStatus)) {
      await this.log(
        ticket.id,
        ticket.eventSessionId,
        CheckInResult.CANCELLED,
        staff.id,
        opts.deviceInfo,
        opts.method,
      );
      return done({
        result: CheckInResult.CANCELLED,
        message: `Ticket is ${ticket.status.toLowerCase()}.`,
        ticket: summary,
      });
    }

    /*
      A seat sourced from another cinema's system is admitted by THAT system. Their scanner
      does not know our QR and ours cannot open their door, so marking the ticket used here
      would tell the customer they were checked in while the gate still refuses them — and
      would leave our records claiming an admission that never happened.

      Reported as EXTERNAL rather than INVALID because it is a genuine, paid ticket. The
      check-in log is a record people read; calling this invalid would be false in it.

      Checked AFTER cancelled/refunded on purpose. A refunded external ticket should read as
      refunded — that is the actionable fact for whoever is holding it. "Scanned elsewhere"
      would send them to another gate that will also refuse them, with less to go on.
    */
    if (ticket.vendorBarcode) {
      await this.log(
        ticket.id,
        ticket.eventSessionId,
        CheckInResult.EXTERNAL,
        staff.id,
        opts.deviceInfo,
        opts.method,
      );
      return done({
        result: CheckInResult.EXTERNAL,
        message: ticket.vendorName
          ? `Scanned at the venue by ${ticket.vendorName}. This ticket is not checked in here.`
          : 'This seat is admitted by the venue’s own system, not here.',
        ticket: summary,
      });
    }

    // Atomic transition ACTIVE -> CHECKED_IN prevents duplicate check-in races.
    const updated = await this.prisma.ticket.updateMany({
      where: { id: ticket.id, status: TicketStatus.ACTIVE },
      data: { status: TicketStatus.CHECKED_IN },
    });
    if (updated.count === 0) {
      await this.log(
        ticket.id,
        ticket.eventSessionId,
        CheckInResult.DUPLICATE,
        staff.id,
        opts.deviceInfo,
        opts.method,
      );
      return done({
        result: CheckInResult.DUPLICATE,
        message: 'Ticket has already been checked in.',
        ticket: { ...summary, status: TicketStatus.CHECKED_IN },
      });
    }

    await this.log(
      ticket.id,
      ticket.eventSessionId,
      CheckInResult.SUCCESS,
      staff.id,
      opts.deviceInfo,
      opts.method,
    );
    await this.audit.record({
      actorUserId: staff.id,
      organizationId: ticket.organizationId,
      /*
        Distinct actions, because an auditor reading this needs to know which happened. A
        scanned admission carries proof the holder had our signed token; a visual one carries
        a staff member's judgement. Filing both under one name would flatten the difference in
        the exact record somebody would consult to find it.
      */
      action: scanned ? 'TICKET_CHECKED_IN' : 'TICKET_ADMITTED_VISUALLY',
      entityType: 'Ticket',
      entityId: ticket.id,
    });
    if (ticket.holderEmail) {
      await this.notifications.send({
        type: NotificationType.TICKET_CHECKED_IN,
        toEmail: ticket.holderEmail,
        payload: { ticketId: ticket.id, serial: ticket.serial },
      });
    }
    this.metrics.recordCheckin();
    return done({
      result: CheckInResult.SUCCESS,
      message: scanned ? 'Checked in successfully.' : 'Admitted. Recorded as a visual check.',
      ticket: { ...summary, status: TicketStatus.CHECKED_IN },
    });
  }

  /**
   * Records the QR check-in scan metric (success vs failure) for every scan
   * outcome and returns it unchanged. Best-effort — MetricsService never throws.
   */
  private withScanMetric(outcome: CheckInOutcome): CheckInOutcome {
    this.metrics.recordQrCheckin(outcome.result === CheckInResult.SUCCESS);
    return outcome;
  }

  /**
   * The tickets for one session, so staff can find the one in front of them.
   *
   * ── WHY A SEARCH AND NOT A LIST ────────────────────────────────────────────────────
   * A busy screening is several hundred seats. Scrolling that on a phone at a door, under
   * time pressure, is how the wrong seat gets admitted — so the useful shape is "type what
   * you can see and get a handful back". Staff read a seat number, a name, or a booking
   * reference off the ticket; all three are searchable.
   *
   * Capped rather than paginated: if a query returns more than this, the answer is a better
   * query, not more scrolling. An empty query returns the first page so the door can see what
   * a quiet screening looks like without typing anything.
   */
  async roster(staff: RequestUser, eventSessionId: string, q?: string) {
    const session = await this.prisma.eventSession.findUnique({
      where: { id: eventSessionId },
      select: { event: { select: { organizationId: true } } },
    });
    if (!session) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Session not found.', HttpStatus.NOT_FOUND);
    }
    await this.access.assertMember(staff, session.event.organizationId, STAFF_ROLES);

    const term = q?.trim();
    const tickets = await this.prisma.ticket.findMany({
      where: {
        eventSessionId,
        ...(term
          ? {
              OR: [
                { seatLabel: { equals: term, mode: 'insensitive' } },
                { seatLabel: { startsWith: term, mode: 'insensitive' } },
                { holderName: { contains: term, mode: 'insensitive' } },
                { serial: { contains: term, mode: 'insensitive' } },
                { booking: { reference: { contains: term, mode: 'insensitive' } } },
                { booking: { buyerName: { contains: term, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        bookingId: true,
        serial: true,
        status: true,
        seatLabel: true,
        holderName: true,
        vendorName: true,
        vendorBarcode: true,
        ticketType: { select: { name: true } },
        booking: { select: { reference: true, buyerName: true } },
      },
      orderBy: [{ seatLabel: 'asc' }, { serial: 'asc' }],
      take: 50,
    });

    return tickets.map((t) => ({
      id: t.id,
      // So the door can reprint the whole booking for somebody who arrived without a phone.
      bookingId: t.bookingId,
      serial: t.serial,
      status: t.status,
      seatLabel: t.seatLabel,
      ticketType: t.ticketType.name,
      // Whoever the door will be looking for: the named attendee if there is one, else the
      // person who bought it.
      name: t.holderName ?? t.booking.buyerName ?? null,
      reference: t.booking.reference,
      /* A seat another cinema admits. Surfaced so staff are not left wondering why the
         Admit button refuses it. */
      admittedElsewhereBy: t.vendorBarcode ? (t.vendorName ?? 'the venue') : null,
    }));
  }

  /** Authorized reversal of a check-in (organizer/admin only). */
  async reverse(user: RequestUser, ticketId: string) {
    const ticket = await this.prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Ticket not found.', HttpStatus.NOT_FOUND);
    await this.access.assertMember(user, ticket.organizationId, [
      Role.ORGANIZER_OWNER,
      Role.ORGANIZER_MANAGER,
    ]);

    if (ticket.status !== TicketStatus.CHECKED_IN) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'Only a checked-in ticket can be reversed.',
        HttpStatus.CONFLICT,
      );
    }
    await this.prisma.$transaction([
      this.prisma.ticket.update({ where: { id: ticketId }, data: { status: TicketStatus.ACTIVE } }),
      this.prisma.checkIn.updateMany({
        where: { ticketId, result: CheckInResult.SUCCESS, reversed: false },
        data: { reversed: true, reversedByUserId: user.id, reversedAt: new Date() },
      }),
    ]);
    await this.audit.record({
      actorUserId: user.id,
      organizationId: ticket.organizationId,
      action: 'CHECKIN_REVERSED',
      entityType: 'Ticket',
      entityId: ticketId,
    });
    return { result: 'REVERSED', ticketId };
  }

  private log(
    ticketId: string,
    eventSessionId: string,
    result: CheckInResult,
    byUserId: string,
    deviceInfo?: string,
    method: 'SCAN' | 'VISUAL' = 'SCAN',
  ) {
    return this.prisma.checkIn.create({
      data: { ticketId, eventSessionId, result, byUserId, deviceInfo, method },
    });
  }

  /**
   * Admit a ticket a staff member has identified by eye rather than by scanner.
   *
   * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
   * Most Indian cinemas admit visually: somebody reads the ticket, finds the screen and the
   * seat, and waves the customer through. Nothing was recorded when they did, so occupancy
   * and reconciliation only ever counted the scans — and "how full was that show" had no
   * answer for the venues that make up most of the market.
   *
   * ── WHY IT IS NOT JUST scan() WITH A DIFFERENT INPUT ───────────────────────────────
   * It is the same rules and a different *identification*. Everything that decides whether a
   * ticket may be admitted — cancelled, refunded, wrong session, already used, admitted by
   * another cinema's system — is shared with the scan path below, deliberately, because two
   * implementations of "may this person come in" is how one of them quietly starts saying yes
   * to something the other refuses.
   *
   * What differs is the EVIDENCE, and that is recorded: `method: VISUAL`. A scan verifies a
   * signed token; this verifies that a person looked. Both admit a customer, and only one of
   * them is proof.
   */
  async admitVisually(
    staff: RequestUser,
    ticketId: string,
    opts: { expectedSessionId?: string; deviceInfo?: string } = {},
  ): Promise<CheckInOutcome> {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        ticketType: { select: { name: true } },
        booking: { select: { reference: true } },
      },
    });
    if (!ticket) {
      return { result: CheckInResult.INVALID, message: 'Ticket not found.' };
    }
    await this.access.assertMember(staff, ticket.organizationId, STAFF_ROLES);
    return this.admit(ticket, staff, { ...opts, method: 'VISUAL' });
  }
}
