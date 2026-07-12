import { HttpStatus, Injectable } from '@nestjs/common';
import * as QRCode from 'qrcode';
import { BookingStatus, TicketStatus } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { QrService } from './qr.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';

@Injectable()
export class TicketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly qr: QrService,
  ) {}

  /** The customer's ticket wallet: confirmed, non-void tickets with QR codes. */
  async wallet(user: RequestUser) {
    const tickets = await this.prisma.ticket.findMany({
      where: {
        booking: {
          userId: user.id,
          status: { in: [BookingStatus.CONFIRMED, BookingStatus.PARTIALLY_REFUNDED] },
        },
        status: { in: [TicketStatus.ACTIVE, TicketStatus.CHECKED_IN] },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        ticketType: { select: { name: true } },
        eventSession: {
          select: { startsAt: true, event: { select: { title: true, slug: true } } },
        },
      },
    });
    return Promise.all(tickets.map((t) => this.decorate(t)));
  }

  async getForUser(user: RequestUser, id: string) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id },
      include: {
        booking: { select: { userId: true } },
        ticketType: { select: { name: true } },
        eventSession: {
          select: { startsAt: true, event: { select: { title: true, slug: true } } },
        },
      },
    });
    if (!ticket)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Ticket not found.', HttpStatus.NOT_FOUND);
    const isAdmin =
      user.roles.includes('ADMIN' as never) || user.roles.includes('SUPER_ADMIN' as never);
    if (ticket.booking.userId !== user.id && !isAdmin) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'You cannot view this ticket.',
        HttpStatus.FORBIDDEN,
      );
    }
    return this.decorate(ticket);
  }

  private async decorate(ticket: {
    id: string;
    eventSessionId: string;
    nonce: string;
    qrVersion: number;
    serial: string;
    status: string;
    holderName: string | null;
    ticketType: { name: string };
    eventSession: { startsAt: Date; event: { title: string; slug: string } };
  }) {
    const token = this.qr.sign({
      ticketId: ticket.id,
      eventSessionId: ticket.eventSessionId,
      nonce: ticket.nonce,
      version: ticket.qrVersion,
    });
    const qrDataUrl = await QRCode.toDataURL(token, { margin: 1, width: 320 });
    return {
      id: ticket.id,
      serial: ticket.serial,
      status: ticket.status,
      holderName: ticket.holderName,
      ticketType: ticket.ticketType.name,
      event: ticket.eventSession.event,
      startsAt: ticket.eventSession.startsAt,
      qrToken: token,
      qrDataUrl,
    };
  }
}
