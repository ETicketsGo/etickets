import { HttpStatus, Injectable } from '@nestjs/common';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AuditService } from '../audit/audit.service';
import { Role, TicketInviteKind, TicketInviteStatus } from '@eticketsgo/shared-types';
import * as QRCode from 'qrcode';
import { BookingStatus } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { QrService } from './qr.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';
import {
  ACCEPTED_TRANSFERS,
  currentHolderUserId,
  everHeldBy,
  isTransferred,
} from './ticket-holder';

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
          // The venue's zone is the fallback for every event that is not in a cinema.
          venue: { select: { name: true, city: true, timezone: true } },
        },
      },
    },
  },
  // Who holds the ticket now. Decides who is handed the QR; see `ticket-holder.ts`.
  invites: ACCEPTED_TRANSFERS,
};

const STAFF_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER, Role.CHECKIN_STAFF];

@Injectable()
export class TicketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly qr: QrService,
    private readonly access: OrgAccessService,
    private readonly audit: AuditService,
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
        OR: [
          { booking: { userId: user.id } },
          { attendeeUserId: user.id },
          /*
            Somebody a ticket was TRANSFERRED to keeps it in their wallet after assigning it
            onward to a friend, the same way a buyer keeps the tickets they assign. Being listed
            is history, not a credential: `decorate` decides who is handed the QR.
          */
          {
            invites: {
              some: {
                kind: TicketInviteKind.TRANSFER,
                status: TicketInviteStatus.ACCEPTED,
                acceptedByUserId: user.id,
              },
            },
          },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { serial: 'asc' }],
      include: TICKET_INCLUDE,
    });
    return Promise.all(tickets.map((t) => this.decorate(t, user.id)));
  }

  /**
   * Every ticket on one booking, for organizer staff to print at the counter.
   *
   * ── WHY THIS IS A SEPARATE METHOD AND NOT `wallet` WITH A FILTER ───────────────────
   * The wallet answers "what did I buy". This answers "what did THIS CUSTOMER buy", asked by
   * somebody who is not them. Same data, entirely different authorisation: membership of the
   * organization that sold it, not ownership of it. Folding the two together would put one
   * `if` between a stranger and somebody else's tickets.
   *
   * ── WHY IT IS AUDITED ──────────────────────────────────────────────────────────────
   * The rendered QR is a bearer credential — whoever holds it can be admitted. Staff printing
   * one for a customer at the counter is exactly what this is for, and printing one for
   * somebody who never asked is how a seat gets used by the wrong person. That difference is
   * invisible unless the act is recorded, so it is.
   *
   * ── WHY A TRANSFERRED TICKET PRINTS WITHOUT ITS QR ─────────────────────────────────
   * The booking's customer gave that ticket away. Printing its code for them at the counter
   * would hand the giver the recipient's credential — the exact defect the wallet had — through
   * a door with a person standing in it who has no way to know. The sheet still lists the
   * ticket and says it was transferred.
   */
  async ticketsForBookingAsStaff(staff: RequestUser, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, organizationId: true, status: true, reference: true },
    });
    if (!booking) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Booking not found.', HttpStatus.NOT_FOUND);
    }
    await this.access.assertMember(staff, booking.organizationId, STAFF_ROLES);

    const tickets = await this.prisma.ticket.findMany({
      where: { bookingId },
      orderBy: [{ seatLabel: 'asc' }, { serial: 'asc' }],
      include: TICKET_INCLUDE,
    });

    await this.audit.record({
      actorUserId: staff.id,
      organizationId: booking.organizationId,
      action: 'BOOKING_TICKETS_PRINTED',
      entityType: 'Booking',
      entityId: booking.id,
      metadata: { reference: booking.reference, tickets: tickets.length },
    });

    /*
      `decorate` takes the viewing user so it can say whether they own the ticket. Staff own
      none of these, and saying so is correct — the printed sheet has no owner-only actions on
      it, and claiming otherwise would be a small lie in a payload people build UI from.
    */
    return Promise.all(tickets.map((t) => this.decorate(t, staff.id)));
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
    // The buyer, anybody it was transferred to, or the assigned attendee may VIEW a ticket.
    // Whether they are handed its QR is a separate question, answered in `decorate`.
    if (!everHeldBy(ticket, user.id) && ticket.attendeeUserId !== user.id && !isAdmin) {
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
      // Accepted transfers, newest first (ACCEPTED_TRANSFERS).
      invites?: { acceptedByUserId: string | null }[];
      ticketType: { name: string };
      eventSession: {
        startsAt: Date;
        screen: { name: string; cinema: { name: string; timezone: string | null } | null } | null;
        event: {
          title: string;
          slug: string;
          experienceType: string;
          venue: { name: string; city: string; timezone?: string | null } | null;
        };
      };
    },
    viewerUserId: string,
  ) {
    /*
      ── A TRANSFERRED TICKET'S CREDENTIAL BELONGS TO ITS NEW HOLDER ─────────────────
      Accepting a transfer rotated the QR, but this method re-signed the QR from the ticket's
      CURRENT nonce for every viewer who could see the ticket — so the buyer who had just given
      it away was handed the new code too, and whichever of the two reached the gate first got
      in. The rotation invalidated nothing that mattered.

      So once a ticket has been transferred, the credential goes only to its current holder and
      to the attendee it is assigned to. Everybody else who may still see the ticket — the
      buyer, a previous holder, staff printing the booking, a platform admin — sees that it
      exists and that it was transferred, and nothing that opens a gate. That includes a
      third-party barcode, which IS the gate credential for those tickets.

      A ticket that was never transferred is unchanged for every viewer.
    */
    const transferred = isTransferred(ticket);
    const holderUserId = currentHolderUserId(ticket);
    const mayPresent =
      !transferred || viewerUserId === holderUserId || viewerUserId === ticket.attendeeUserId;

    const token = mayPresent
      ? this.qr.sign({
          ticketId: ticket.id,
          eventSessionId: ticket.eventSessionId,
          nonce: ticket.nonce,
          version: ticket.qrVersion,
        })
      : null;
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
    const presented = mayPresent ? (ticket.vendorBarcode ?? token) : null;
    const qrDataUrl =
      presented && rendersAsQr
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
      // Null when this viewer may see the ticket but not present it (see above).
      qrToken: token,
      qrDataUrl,
      // Null on our own tickets. Present means the gate is somebody else's.
      vendorBarcode: mayPresent ? (ticket.vendorBarcode ?? null) : null,
      vendorBarcodeFormat:
        mayPresent && ticket.vendorBarcode ? (ticket.vendorBarcodeFormat ?? 'QR') : null,
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

        An event that is not in a cinema has no screen, so this was null for every concert,
        conference and match, and those tickets went back to the device's zone. The venue has
        carried its own zone since then; it is the fallback, in the same order the booking
        confirmation already uses, so a ticket and its confirmation cannot disagree.
      */
      timezone: screen?.cinema?.timezone ?? event.venue?.timezone ?? null,
      // Attendee identity (ADR-031): assignment lifecycle + whether the viewer is
      // the ticket's owner (vs an attendee this ticket was assigned to).
      assignmentStatus: ticket.assignmentStatus,
      attendeeName: ticket.holderName,
      // The CURRENT holder, which after a transfer is no longer the buyer. Clients key
      // owner-only actions (assign, transfer, share) off this, and the server now refuses
      // those actions to anybody else.
      ownedByViewer: holderUserId !== null && holderUserId === viewerUserId,
      assignedToViewer: ticket.attendeeUserId === viewerUserId,
      transferred,
    };
  }
}
