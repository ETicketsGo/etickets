import { HttpStatus, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import {
  AttendeeAssignmentStatus,
  NotificationType,
  TicketInviteKind,
  TicketInviteStatus,
  TicketStatus,
} from '@eticketsgo/shared-types';
import type {
  AssignAttendeeInput,
  InviteAttendeeInput,
  TransferTicketInput,
} from '@eticketsgo/validation';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';

const INVITE_TTL_DAYS = 7;

/** A ticket must be live (not checked-in/refunded/cancelled) to change hands. */
const ASSIGNABLE: string[] = [TicketStatus.ACTIVE];

/**
 * The attendee identity layer (ADR-031). Assigns tickets to people, sends
 * tokenised invitations/transfers, and rotates the QR nonce on every ownership
 * change so only one QR is ever valid. Reuses Ticket + Notification + Audit;
 * never touches booking, payment, inventory, or the QR signing algorithm.
 */
@Injectable()
export class AttendeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  // ── token + nonce helpers ─────────────────────────────────────────────
  private hash(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }
  private newToken(): { raw: string; hash: string } {
    const raw = randomBytes(24).toString('base64url');
    return { raw, hash: this.hash(raw) };
  }
  private newNonce(): string {
    return randomBytes(8).toString('hex');
  }

  private isAdmin(user: RequestUser): boolean {
    return user.roles.includes('ADMIN' as never) || user.roles.includes('SUPER_ADMIN' as never);
  }

  /** Loads a ticket the caller may manage (booking owner or admin). */
  private async loadManageableTicket(user: RequestUser, ticketId: string) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: { booking: { select: { userId: true, reference: true } } },
    });
    if (!ticket)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Ticket not found.', HttpStatus.NOT_FOUND);
    if (ticket.booking.userId !== user.id && !this.isAdmin(user)) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'Only the booking owner can manage attendees.',
        HttpStatus.FORBIDDEN,
      );
    }
    return ticket;
  }

  private assertAssignable(status: string) {
    if (!ASSIGNABLE.includes(status)) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `A ${status.toLowerCase()} ticket cannot be reassigned.`,
        HttpStatus.CONFLICT,
      );
    }
  }

  // ── direct assignment ─────────────────────────────────────────────────
  /** Owner fills in who holds a ticket (no invitation round-trip). */
  async assign(user: RequestUser, ticketId: string, dto: AssignAttendeeInput) {
    const ticket = await this.loadManageableTicket(user, ticketId);
    this.assertAssignable(ticket.status);

    // Link an existing account if the email matches one (enables their wallet).
    const account = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { id: true },
    });

    const updated = await this.prisma.ticket.update({
      where: { id: ticketId },
      data: {
        holderName: dto.name,
        holderEmail: dto.email,
        attendeePhone: dto.phone ?? null,
        attendeeCountry: dto.country ?? null,
        attendeeCompany: dto.company ?? null,
        attendeeDesignation: dto.designation ?? null,
        attendeeStudentId: dto.studentId ?? null,
        attendeeMemberId: dto.memberId ?? null,
        attendeeCustomFields: dto.customFields ?? undefined,
        attendeeUserId: account?.id ?? null,
        assignmentStatus: AttendeeAssignmentStatus.ASSIGNED,
      },
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: ticket.organizationId,
      action: 'ATTENDEE_ASSIGNED',
      entityType: 'Ticket',
      entityId: ticketId,
      metadata: { email: dto.email, linkedAccount: !!account },
    });
    return this.publicTicket(updated);
  }

  // ── invitation / transfer ─────────────────────────────────────────────
  async invite(user: RequestUser, ticketId: string, dto: InviteAttendeeInput) {
    return this.createInvite(user, ticketId, dto, TicketInviteKind.INVITE);
  }
  async transfer(user: RequestUser, ticketId: string, dto: TransferTicketInput) {
    return this.createInvite(user, ticketId, dto, TicketInviteKind.TRANSFER);
  }

  private async createInvite(
    user: RequestUser,
    ticketId: string,
    dto: InviteAttendeeInput,
    kind: TicketInviteKind,
  ) {
    const ticket = await this.loadManageableTicket(user, ticketId);
    this.assertAssignable(ticket.status);

    const { raw, hash } = this.newToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000);

    const invite = await this.prisma.$transaction(async (tx) => {
      // Supersede any outstanding invite so only one claim link is ever live.
      await tx.ticketInvite.updateMany({
        where: { ticketId, status: TicketInviteStatus.PENDING },
        data: { status: TicketInviteStatus.REVOKED, resolvedAt: new Date() },
      });
      const created = await tx.ticketInvite.create({
        data: {
          ticketId,
          organizationId: ticket.organizationId,
          kind,
          email: dto.email,
          phone: dto.phone ?? null,
          tokenHash: hash,
          expiresAt,
          createdByUserId: user.id,
        },
      });
      await tx.ticket.update({
        where: { id: ticketId },
        data: {
          assignmentStatus: AttendeeAssignmentStatus.INVITED,
          holderName: dto.name ?? ticket.holderName,
          holderEmail: dto.email,
        },
      });
      return created;
    });

    await this.notifications.send({
      type: NotificationType.ATTENDEE_INVITED,
      toEmail: dto.email,
      payload: { ticketId, kind, token: raw, ref: ticket.booking.reference ?? ticketId },
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: ticket.organizationId,
      action: kind === TicketInviteKind.TRANSFER ? 'TICKET_TRANSFER_INITIATED' : 'ATTENDEE_INVITED',
      entityType: 'Ticket',
      entityId: ticketId,
      metadata: { inviteId: invite.id, email: dto.email },
    });

    // The raw token is returned so the owner can copy/share the claim link.
    return { id: invite.id, ticketId, email: dto.email, kind, status: invite.status, token: raw };
  }

  /** Re-issues a fresh claim link for a pending invite (invalidates the old one). */
  async resend(user: RequestUser, inviteId: string) {
    const invite = await this.prisma.ticketInvite.findUnique({ where: { id: inviteId } });
    if (!invite || invite.status !== TicketInviteStatus.PENDING)
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'No pending invitation to resend.',
        HttpStatus.NOT_FOUND,
      );
    await this.loadManageableTicket(user, invite.ticketId);

    const { raw, hash } = this.newToken();
    await this.prisma.ticketInvite.update({
      where: { id: inviteId },
      data: { tokenHash: hash, expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000) },
    });
    await this.notifications.send({
      type: NotificationType.ATTENDEE_INVITED,
      toEmail: invite.email,
      payload: { ticketId: invite.ticketId, kind: invite.kind, token: raw },
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: invite.organizationId,
      action: 'ATTENDEE_INVITE_RESENT',
      entityType: 'Ticket',
      entityId: invite.ticketId,
      metadata: { inviteId },
    });
    return { id: inviteId, email: invite.email, token: raw };
  }

  /** Validates a claim token, returns PENDING invite or throws (expiry/replay). */
  private async resolveInvite(rawToken: string) {
    const invite = await this.prisma.ticketInvite.findUnique({
      where: { tokenHash: this.hash(rawToken) },
    });
    if (!invite || invite.status !== TicketInviteStatus.PENDING) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'This invitation is no longer valid.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (invite.expiresAt.getTime() <= Date.now()) {
      await this.prisma.ticketInvite.update({
        where: { id: invite.id },
        data: { status: TicketInviteStatus.EXPIRED, resolvedAt: new Date() },
      });
      throw new AppException(
        ErrorCodes.CONFLICT,
        'This invitation has expired.',
        HttpStatus.CONFLICT,
      );
    }
    return invite;
  }

  /** Recipient accepts: relinks the ticket to their account and rotates the QR. */
  async accept(user: RequestUser, rawToken: string) {
    const invite = await this.resolveInvite(rawToken);
    const ticket = await this.prisma.ticket.findUnique({ where: { id: invite.ticketId } });
    if (!ticket)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Ticket not found.', HttpStatus.NOT_FOUND);
    this.assertAssignable(ticket.status);

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.ticketInvite.update({
        where: { id: invite.id },
        data: {
          status: TicketInviteStatus.ACCEPTED,
          acceptedByUserId: user.id,
          resolvedAt: new Date(),
        },
      });
      // Ownership changes → rotate the QR nonce so the previous QR is dead.
      return tx.ticket.update({
        where: { id: ticket.id },
        data: {
          attendeeUserId: user.id,
          holderName: user.fullName,
          holderEmail: user.email,
          assignmentStatus: AttendeeAssignmentStatus.ACCEPTED,
          nonce: this.newNonce(),
          qrVersion: { increment: 1 },
        },
      });
    });

    await this.audit.record({
      actorUserId: user.id,
      organizationId: ticket.organizationId,
      action:
        invite.kind === TicketInviteKind.TRANSFER ? 'TICKET_TRANSFERRED' : 'ATTENDEE_ACCEPTED',
      entityType: 'Ticket',
      entityId: ticket.id,
      metadata: { inviteId: invite.id, qrRotated: true },
    });
    // Notify the original owner.
    const owner = await this.prisma.booking.findFirst({
      where: { tickets: { some: { id: ticket.id } } },
      select: { userId: true, buyerEmail: true },
    });
    if (owner) {
      await this.notifications.send({
        type: NotificationType.ATTENDEE_ACCEPTED,
        userId: owner.userId,
        toEmail: owner.buyerEmail,
        payload: { ticketId: ticket.id, attendee: user.email },
      });
    }
    return this.publicTicket(updated);
  }

  /** Recipient declines; the ticket returns to the owner as unassigned. */
  async decline(user: RequestUser, rawToken: string) {
    const invite = await this.resolveInvite(rawToken);
    await this.prisma.$transaction(async (tx) => {
      await tx.ticketInvite.update({
        where: { id: invite.id },
        data: {
          status: TicketInviteStatus.DECLINED,
          acceptedByUserId: user.id,
          resolvedAt: new Date(),
        },
      });
      await tx.ticket.update({
        where: { id: invite.ticketId },
        data: { assignmentStatus: AttendeeAssignmentStatus.UNASSIGNED },
      });
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: invite.organizationId,
      action: 'ATTENDEE_DECLINED',
      entityType: 'Ticket',
      entityId: invite.ticketId,
      metadata: { inviteId: invite.id },
    });
    const owner = await this.prisma.booking.findFirst({
      where: { tickets: { some: { id: invite.ticketId } } },
      select: { userId: true, buyerEmail: true },
    });
    if (owner) {
      await this.notifications.send({
        type: NotificationType.ATTENDEE_DECLINED,
        userId: owner.userId,
        toEmail: owner.buyerEmail,
        payload: { ticketId: invite.ticketId },
      });
    }
    return { ticketId: invite.ticketId, status: 'DECLINED' };
  }

  /** Owner clears the attendee; rotates the QR so any shared code is invalidated. */
  async unassign(user: RequestUser, ticketId: string) {
    const ticket = await this.loadManageableTicket(user, ticketId);
    this.assertAssignable(ticket.status);
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.ticketInvite.updateMany({
        where: { ticketId, status: TicketInviteStatus.PENDING },
        data: { status: TicketInviteStatus.REVOKED, resolvedAt: new Date() },
      });
      return tx.ticket.update({
        where: { id: ticketId },
        data: {
          assignmentStatus: AttendeeAssignmentStatus.UNASSIGNED,
          attendeeUserId: null,
          attendeePhone: null,
          attendeeCountry: null,
          attendeeCompany: null,
          attendeeDesignation: null,
          attendeeStudentId: null,
          attendeeMemberId: null,
          attendeeCustomFields: undefined,
          nonce: this.newNonce(),
          qrVersion: { increment: 1 },
        },
      });
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: ticket.organizationId,
      action: 'ATTENDEE_UNASSIGNED',
      entityType: 'Ticket',
      entityId: ticketId,
      metadata: { qrRotated: true },
    });
    return this.publicTicket(updated);
  }

  // ── owner dashboard ───────────────────────────────────────────────────
  /** Per-booking attendee summary + counts (owner or admin). */
  async summaryForBooking(user: RequestUser, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { userId: true, reference: true },
    });
    if (!booking)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Booking not found.', HttpStatus.NOT_FOUND);
    if (booking.userId !== user.id && !this.isAdmin(user)) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'You cannot view this booking.',
        HttpStatus.FORBIDDEN,
      );
    }
    const tickets = await this.prisma.ticket.findMany({
      where: { bookingId },
      orderBy: [{ createdAt: 'asc' }, { serial: 'asc' }],
      include: {
        ticketType: { select: { name: true } },
        invites: {
          where: { status: TicketInviteStatus.PENDING },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, email: true, kind: true, expiresAt: true },
        },
      },
    });

    const counts = {
      total: tickets.length,
      unassigned: 0,
      assigned: 0,
      invited: 0,
      accepted: 0,
      declined: 0,
      checkedIn: 0,
    };
    for (const t of tickets) {
      if (t.status === TicketStatus.CHECKED_IN) counts.checkedIn++;
      switch (t.assignmentStatus) {
        case AttendeeAssignmentStatus.UNASSIGNED:
          counts.unassigned++;
          break;
        case AttendeeAssignmentStatus.ASSIGNED:
          counts.assigned++;
          break;
        case AttendeeAssignmentStatus.INVITED:
          counts.invited++;
          break;
        case AttendeeAssignmentStatus.ACCEPTED:
          counts.accepted++;
          break;
        case AttendeeAssignmentStatus.DECLINED:
          counts.declined++;
          break;
      }
    }

    return {
      bookingId,
      reference: booking.reference,
      counts,
      tickets: tickets.map((t) => ({
        id: t.id,
        serial: t.serial,
        seatLabel: t.seatLabel,
        ticketType: t.ticketType.name,
        status: t.status,
        assignmentStatus: t.assignmentStatus,
        attendeeName: t.holderName,
        attendeeEmail: t.holderEmail,
        pendingInvite: t.invites[0] ?? null,
      })),
    };
  }

  private publicTicket(t: {
    id: string;
    serial: string;
    status: string;
    assignmentStatus: string;
    holderName: string | null;
    holderEmail: string | null;
    seatLabel: string | null;
  }) {
    return {
      id: t.id,
      serial: t.serial,
      status: t.status,
      assignmentStatus: t.assignmentStatus,
      attendeeName: t.holderName,
      attendeeEmail: t.holderEmail,
      seatLabel: t.seatLabel,
    };
  }
}
