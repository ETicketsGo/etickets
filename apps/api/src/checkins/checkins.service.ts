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
      return { result: CheckInResult.INVALID, message: 'Invalid or unverifiable ticket code.' };
    }

    const ticket = await this.prisma.ticket.findUnique({
      where: { id: payload.ticketId },
      include: { ticketType: { select: { name: true } } },
    });
    if (!ticket || ticket.nonce !== payload.nonce) {
      return { result: CheckInResult.INVALID, message: 'Ticket not found.' };
    }

    // Staff must belong to the ticket's organization.
    await this.access.assertMember(staff, ticket.organizationId, STAFF_ROLES);

    const summary = {
      id: ticket.id,
      serial: ticket.serial,
      holderName: ticket.holderName,
      ticketType: ticket.ticketType.name,
      status: ticket.status,
    };

    if (opts.expectedSessionId && opts.expectedSessionId !== ticket.eventSessionId) {
      await this.log(
        ticket.id,
        ticket.eventSessionId,
        CheckInResult.WRONG_SESSION,
        staff.id,
        opts.deviceInfo,
      );
      return {
        result: CheckInResult.WRONG_SESSION,
        message: 'This ticket is for a different session.',
        ticket: summary,
      };
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
      );
      return {
        result: CheckInResult.CANCELLED,
        message: `Ticket is ${ticket.status.toLowerCase()}.`,
        ticket: summary,
      };
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
      );
      return {
        result: CheckInResult.DUPLICATE,
        message: 'Ticket has already been checked in.',
        ticket: { ...summary, status: TicketStatus.CHECKED_IN },
      };
    }

    await this.log(
      ticket.id,
      ticket.eventSessionId,
      CheckInResult.SUCCESS,
      staff.id,
      opts.deviceInfo,
    );
    await this.audit.record({
      actorUserId: staff.id,
      organizationId: ticket.organizationId,
      action: 'TICKET_CHECKED_IN',
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
    return {
      result: CheckInResult.SUCCESS,
      message: 'Checked in successfully.',
      ticket: { ...summary, status: TicketStatus.CHECKED_IN },
    };
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
  ) {
    return this.prisma.checkIn.create({
      data: { ticketId, eventSessionId, result, byUserId, deviceInfo },
    });
  }
}
