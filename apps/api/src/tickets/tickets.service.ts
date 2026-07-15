import { HttpStatus, Injectable } from '@nestjs/common';
import * as QRCode from 'qrcode';
import { BookingStatus } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { QrService } from './qr.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';

/**
 * Shared relations loaded for every wallet/ticket read. Adds the booking-grouping
 * and seat/venue/screen context the customer ticket wallet needs, alongside the
 * existing event + ticket-type fields. Purely additive to the response shape.
 */
const TICKET_INCLUDE = {
  booking: { select: { reference: true } },
  ticketType: { select: { name: true } },
  eventSession: {
    select: {
      startsAt: true,
      screen: { select: { name: true, cinema: { select: { name: true } } } },
      event: {
        select: {
          title: true,
          slug: true,
          experienceType: true,
          venue: { select: { name: true, city: true } },
        },
      },
    },
  },
};

@Injectable()
export class TicketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly qr: QrService,
  ) {}

  /**
   * The customer's ticket wallet. Returns every ticket of the user's confirmed /
   * partially-refunded bookings — including checked-in, refunded, cancelled and
   * void tickets — so the UI can group by booking and render an accurate group
   * history (e.g. "1 refunded · 3 active") without hiding booking history. The
   * refund / check-in business logic that sets these statuses is untouched; this
   * is a read-only projection. Ordered newest booking first, then by seat/serial.
   */
  async wallet(user: RequestUser) {
    const tickets = await this.prisma.ticket.findMany({
      where: {
        booking: {
          userId: user.id,
          status: { in: [BookingStatus.CONFIRMED, BookingStatus.PARTIALLY_REFUNDED] },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { serial: 'asc' }],
      include: TICKET_INCLUDE,
    });
    return Promise.all(tickets.map((t) => this.decorate(t)));
  }

  async getForUser(user: RequestUser, id: string) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id },
      include: {
        ...TICKET_INCLUDE,
        booking: { select: { userId: true, reference: true } },
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
    bookingId: string;
    eventSessionId: string;
    nonce: string;
    qrVersion: number;
    serial: string;
    status: string;
    seatLabel: string | null;
    holderName: string | null;
    booking: { reference: string | null };
    ticketType: { name: string };
    eventSession: {
      startsAt: Date;
      screen: { name: string; cinema: { name: string } | null } | null;
      event: {
        title: string;
        slug: string;
        experienceType: string;
        venue: { name: string; city: string } | null;
      };
    };
  }) {
    const token = this.qr.sign({
      ticketId: ticket.id,
      eventSessionId: ticket.eventSessionId,
      nonce: ticket.nonce,
      version: ticket.qrVersion,
    });
    const qrDataUrl = await QRCode.toDataURL(token, { margin: 1, width: 320 });
    const { event, screen } = ticket.eventSession;
    return {
      id: ticket.id,
      serial: ticket.serial,
      status: ticket.status,
      holderName: ticket.holderName,
      ticketType: ticket.ticketType.name,
      event: { title: event.title, slug: event.slug },
      startsAt: ticket.eventSession.startsAt,
      qrToken: token,
      qrDataUrl,
      // Additive fields for booking grouping + seat/screen context.
      bookingId: ticket.bookingId,
      // Prefer the real public reference; fall back to a derived short code for
      // legacy/pending bookings that predate reference assignment.
      bookingRef: ticket.booking.reference ?? ticket.bookingId.slice(-6).toUpperCase(),
      experienceType: event.experienceType,
      seatLabel: ticket.seatLabel,
      venueName: event.venue?.name ?? null,
      screenName: screen?.name ?? null,
      cinemaName: screen?.cinema?.name ?? null,
    };
  }
}
