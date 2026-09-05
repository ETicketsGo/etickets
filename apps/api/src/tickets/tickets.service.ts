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
  booking: { select: { reference: true, userId: true } },
  ticketType: { select: { name: true } },
  eventSession: {
    select: {
      startsAt: true,
      screen: { select: { name: true, cinema: { select: { name: true, timezone: true } } } },
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
        booking: { status: { in: [BookingStatus.CONFIRMED, BookingStatus.PARTIALLY_REFUNDED] } },
        // The buyer sees their booking's tickets; an attendee also sees tickets
        // assigned to them (the identity layer — "My Experiences").
        OR: [{ booking: { userId: user.id } }, { attendeeUserId: user.id }],
      },
      orderBy: [{ createdAt: 'desc' }, { serial: 'asc' }],
      include: TICKET_INCLUDE,
    });
    return Promise.all(tickets.map((t) => this.decorate(t, user.id)));
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
    // Owner OR the assigned attendee may view a single ticket.
    if (ticket.booking.userId !== user.id && ticket.attendeeUserId !== user.id && !isAdmin) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'You cannot view this ticket.',
        HttpStatus.FORBIDDEN,
      );
    }
    return this.decorate(ticket, user.id);
  }

  private async decorate(
    ticket: {
      id: string;
      bookingId: string;
      eventSessionId: string;
      nonce: string;
      qrVersion: number;
      serial: string;
      status: string;
      seatLabel: string | null;
      holderName: string | null;
      assignmentStatus: string;
      attendeeUserId: string | null;
      // Null on our own tickets; set when the seat came from another cinema's system.
      vendorBarcode?: string | null;
      vendorBarcodeFormat?: string | null;
      vendorName?: string | null;
      booking: { reference: string | null; userId: string | null };
      ticketType: { name: string };
      eventSession: {
        startsAt: Date;
        screen: { name: string; cinema: { name: string; timezone: string | null } | null } | null;
        event: {
          title: string;
          slug: string;
          experienceType: string;
          venue: { name: string; city: string } | null;
        };
      };
    },
    viewerUserId: string,
  ) {
    const token = this.qr.sign({
      ticketId: ticket.id,
      eventSessionId: ticket.eventSessionId,
      nonce: ticket.nonce,
      version: ticket.qrVersion,
    });
    /*
      ── WHAT THE CUSTOMER PRESENTS AT THE DOOR ──────────────────────────────────────
      For a seat sourced from another cinema's system, that is THEIR barcode. Their scanner
      has never heard of ours, so rendering our QR gives the customer a code that will not
      open the gate — and they find out at the door, holding a ticket they paid for.

      Our signed token is still minted and still returned: it identifies the ticket to us,
      for support and reconciliation. It just stops being the thing on the screen.

      A non-QR symbology is not rendered here at all. Encoding CODE128 content into a QR
      produces a scannable image of the wrong shape — worse than no image, because it looks
      right. The client is told the format and the value and can render it properly.
    */
    const rendersAsQr = !ticket.vendorBarcode || (ticket.vendorBarcodeFormat ?? 'QR') === 'QR';
    const presented = ticket.vendorBarcode ?? token;
    const qrDataUrl = rendersAsQr
      ? await QRCode.toDataURL(presented, { margin: 1, width: 320 })
      : null;
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
      // Null on our own tickets. Present means the gate is somebody else's.
      vendorBarcode: ticket.vendorBarcode ?? null,
      vendorBarcodeFormat: ticket.vendorBarcode ? (ticket.vendorBarcodeFormat ?? 'QR') : null,
      vendorName: ticket.vendorName ?? null,
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
      /*
        ── THE ZONE THE SHOW ACTUALLY STARTS IN ──────────────────────────────────────
        A ticket is checked by a person comparing the time printed on it to the time on the
        wall. The wallet rendered `startsAt` in the DEVICE's timezone, so a phone set to
        another zone — a traveller, a device with the wrong region, a customer buying from
        abroad for family at home — showed a time that was not when the show starts, on the
        one screen where being wrong sends somebody to the wrong screening.

        The cinema's zone is authoritative and already stored. Sent so the client can render
        the venue's time and SAY which zone it is, rather than silently using its own.
      */
      timezone: screen?.cinema?.timezone ?? null,
      // Attendee identity (ADR-031): assignment lifecycle + whether the viewer is
      // the booking owner (vs an attendee this ticket was assigned to).
      assignmentStatus: ticket.assignmentStatus,
      attendeeName: ticket.holderName,
      ownedByViewer: ticket.booking.userId === viewerUserId,
      assignedToViewer: ticket.attendeeUserId === viewerUserId,
    };
  }
}
