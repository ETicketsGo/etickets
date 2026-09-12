import { ResourceType, SharePermission, TicketStatus } from '@eticketsgo/shared-types';
import type { QrService } from '../../tickets/qr.service';
import { currentHolderUserId } from '../../tickets/ticket-holder';
import type { ShareableResource, ShareView } from '../shareable-resource';

/** The shape the ticket resolver loads for a shareable ticket. */
export interface ShareableTicketRow {
  id: string;
  organizationId: string;
  status: string;
  nonce: string;
  qrVersion: number;
  eventSessionId: string;
  serial: string;
  seatLabel: string | null;
  holderName: string | null;
  booking: { userId: string | null; reference: string | null };
  /** Accepted TRANSFER invites, newest first (`ACCEPTED_TRANSFERS`). */
  invites?: { acceptedByUserId: string | null }[];
  ticketType: { name: string };
  eventSession: {
    startsAt: Date;
    endsAt: Date;
    screen: { name: string; cinema: { name: string; timezone?: string | null } | null } | null;
    event: {
      title: string;
      experienceType: string;
      venue: { name: string; timezone?: string | null } | null;
    };
  };
}

/**
 * Adapts a Ticket to the generic ShareableResource. Encodes the ticket-specific
 * sharing policy: only GUEST access exposes the live QR / allows check-in; VIEW is
 * read-only; TRANSFER hands over ownership (accepted via the attendee flow).
 */
export class TicketShareableResource implements ShareableResource {
  readonly resourceType = ResourceType.TICKET;
  constructor(
    private readonly row: ShareableTicketRow,
    private readonly qr: QrService,
  ) {}

  get id() {
    return this.row.id;
  }
  get organizationId() {
    return this.row.organizationId;
  }
  /*
    The CURRENT holder, not the buyer.

    This returned `booking.userId`, so a buyer who had transferred a ticket could still create a
    GUEST share for it — and a guest share renders the live QR, which after the transfer is the
    recipient's. Giving a ticket away and keeping a link that opens the gate is not giving it away.
  */
  get ownerUserId() {
    return currentHolderUserId(this.row);
  }
  get status() {
    return this.row.status;
  }
  get endsAt() {
    return this.row.eventSession.endsAt;
  }

  private isLive() {
    return this.row.status === TicketStatus.ACTIVE;
  }

  canShowLiveQr(permission: SharePermission): boolean {
    // Guest access shows the single real QR (no second QR is ever minted).
    return permission === SharePermission.GUEST && this.isLive();
  }
  canCheckIn(permission: SharePermission): boolean {
    return permission === SharePermission.GUEST && this.isLive();
  }
  canTransfer(permission: SharePermission): boolean {
    return permission === SharePermission.TRANSFER && this.isLive();
  }
  canDownload(): boolean {
    return false;
  }

  liveQrToken(): string | null {
    if (!this.isLive()) return null;
    return this.qr.sign({
      ticketId: this.row.id,
      eventSessionId: this.row.eventSessionId,
      nonce: this.row.nonce,
      version: this.row.qrVersion,
    });
  }

  toShareView(): ShareView {
    const { event, screen } = this.row.eventSession;
    const isMovie = event.experienceType === 'MOVIE';
    return {
      resourceType: this.resourceType,
      title: event.title,
      subtitle: this.row.ticketType.name,
      status: this.row.status,
      reference: this.row.booking.reference,
      ticketType: this.row.ticketType.name,
      attendeeName: this.row.holderName,
      seatLabel: this.row.seatLabel,
      venueName: event.venue?.name ?? null,
      screenName: isMovie ? (screen?.name ?? null) : null,
      cinemaName: isMovie ? (screen?.cinema?.name ?? null) : null,
      startsAt: this.row.eventSession.startsAt.toISOString(),
      endsAt: this.row.eventSession.endsAt.toISOString(),
      // The cinema's clock, else the venue's — the same fallback the ticket itself uses. The
      // share page printed the viewer's device time, found by the review.
      timeZone: screen?.cinema?.timezone ?? event.venue?.timezone ?? null,
    };
  }
}
