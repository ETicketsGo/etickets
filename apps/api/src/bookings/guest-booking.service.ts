import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { BookingStatus, NotificationType, type GuestBookingView } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from '../notifications/notification.service';
import { TicketsService } from '../tickets/tickets.service';
import { AppException, ErrorCodes } from '../common/errors';
import { AnonymousSessionService, BookingOwnerResolver } from './orchestration/booking-owner';
import { BookingWorkflowRepository } from './orchestration/booking-workflow.repository';
import {
  guestAccessLink,
  guestAccessTokenMatches,
  hashGuestAccessToken,
  issueGuestAccessToken,
} from './guest-access';

/**
 * How long the lookup route takes, whatever it finds.
 *
 * ── WHY A FLOOR AND NOT JUST THE SAME RESPONSE BODY ────────────────────────────────
 * The body is identical either way, which closes the obvious hole and leaves a quieter one:
 * the matching path writes a token row and enqueues an email, and the non-matching path
 * returns after one SELECT. That difference is tens of milliseconds, measurable over a few
 * requests, and it turns this route back into what it exists not to be — a way to ask whether
 * a booking reference and an email address belong together. Somebody with a list of leaked
 * addresses could confirm which of them bought tickets, to what, without ever being told.
 *
 * So every answer waits out the same budget. It is not constant-time arithmetic — nothing over
 * a database is — but it puts the real work well inside a window that does not vary with the
 * answer, which is the property that matters.
 */
const LOOKUP_FLOOR_MS = 250;

/**
 * Show enough of an address that its owner recognises it, and not enough for anybody else.
 *
 * ── WHY IT IS NEVER THE WHOLE ADDRESS ──────────────────────────────────────────────
 * A guest link arrives by email and email gets forwarded — to the friend who is coming, to a
 * colleague claiming expenses, into a support thread. Whoever opens it holds the credential,
 * and the buyer's identity is not part of what they paid for. The masked form still does the
 * one job the buyer needs from it: confirming that this is THEIR booking and not somebody
 * else's they were sent by mistake.
 *
 * Two characters, because one is not enough to recognise and three starts to be enough to
 * guess. The domain stays: it is the half a reader recognises at a glance, and it is not the
 * half that identifies a person.
 *
 * A local part of two characters or fewer keeps NONE of itself. Two of two is the whole thing,
 * and "never the full address" has to hold for every address or it is not a property — it is a
 * habit that happens to hold for the addresses somebody tested with.
 */
export function maskEmail(email: string | null | undefined): string {
  const value = (email ?? '').trim();
  const at = value.lastIndexOf('@');
  // No local part to keep, or no domain at all: nothing is revealed rather than a best effort.
  if (at <= 0) return '***';
  const keep = at > 2 ? 2 : 0;
  return `${value.slice(0, keep)}***${value.slice(at)}`;
}

/** Everything the view needs, enumerated. Nothing is spread from the booking row. */
const VIEW_SELECT = {
  id: true,
  userId: true,
  reference: true,
  status: true,
  currency: true,
  holdExpiresAt: true,
  // The moment this guest's checkout session started buying; it sets the floor on link expiry.
  createdAt: true,
  buyerName: true,
  buyerEmail: true,
  // The money exactly as the booking snapshotted it. Nothing here is recomputed: a total that
  // is derived twice is a total that can disagree with the receipt and the card statement.
  subtotalMinor: true,
  customerFeeMinor: true,
  taxMinor: true,
  totalMinor: true,
  items: {
    select: {
      label: true,
      quantity: true,
      unitPriceMinor: true,
      ticketTypeId: true,
      ticketType: { select: { name: true } },
      addOn: { select: { name: true } },
      bundle: { select: { name: true } },
    },
  },
  event: {
    select: {
      title: true,
      slug: true,
      // The venue's zone is the fallback for every event that is not in a cinema.
      venue: { select: { name: true, timezone: true } },
    },
  },
  eventSession: {
    select: {
      startsAt: true,
      screen: { select: { name: true, cinema: { select: { name: true, timezone: true } } } },
    },
  },
  tickets: {
    select: {
      id: true,
      ticketTypeId: true,
      seatLabel: true,
      ticketType: { select: { name: true } },
      seat: { select: { label: true, row: { select: { label: true } } } },
      // The latest admission that still stands. A reversed scan is not a check-in, and a
      // DUPLICATE row is the record of somebody being turned away, not let in.
      checkIns: {
        where: { result: 'SUCCESS', reversed: false },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { createdAt: true },
      },
    },
    orderBy: [{ seatLabel: 'asc' }, { serial: 'asc' }],
  },
} satisfies Prisma.BookingSelect;

type BookingForView = {
  id: string;
  userId: string | null;
  reference: string | null;
  status: string;
  currency: string;
  holdExpiresAt: Date | null;
  createdAt: Date;
  buyerName: string;
  buyerEmail: string;
  subtotalMinor: number;
  customerFeeMinor: number;
  taxMinor: number;
  totalMinor: number;
  items: {
    label: string | null;
    quantity: number;
    unitPriceMinor: number;
    ticketTypeId: string | null;
    ticketType: { name: string } | null;
    addOn: { name: string } | null;
    bundle: { name: string } | null;
  }[];
  event: { title: string; slug: string; venue: { name: string; timezone: string | null } | null };
  eventSession: {
    startsAt: Date;
    screen: { name: string; cinema: { name: string; timezone: string | null } | null } | null;
  } | null;
  tickets: {
    id: string;
    ticketTypeId: string | null;
    seatLabel: string | null;
    ticketType: { name: string } | null;
    seat: { label: string; row: { label: string } } | null;
    checkIns: { createdAt: Date }[];
  }[];
};

/**
 * Everything a buyer with no account can do with the booking they paid for.
 *
 * ── THE GAP THIS CLOSES ────────────────────────────────────────────────────────────
 * Guest checkout could create a booking, take the money and issue the tickets, and then the
 * tickets were unreachable: every read path wanted a signed-in user, and the confirmation
 * email carried no link. A customer who bought without an account owned something they could
 * not open. The three routes here are the two ways back in — the checkout session that is
 * still in the browser, and a link emailed to the address that paid — plus the request that
 * mints a fresh link when both have been lost.
 *
 * ── WHY IT IS A SEPARATE SERVICE ───────────────────────────────────────────────────
 * `BookingsService.getForUser` answers "show me my booking" to somebody who proved who they
 * are. These answer it to somebody holding a token, and the two authorisations have nothing in
 * common. Folding them together would put an `if` between an anonymous caller and every
 * account booking on the platform, which is exactly the shape `TicketsService` split apart for
 * counter printing. Here the separation goes further: the projection is smaller too, because a
 * forwardable link must not carry the buyer's address or the card that paid.
 */
@Injectable()
export class GuestBookingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tickets: TicketsService,
    private readonly notifications: NotificationService,
    private readonly config: ConfigService,
    private readonly anon: AnonymousSessionService,
    private readonly owners: BookingOwnerResolver,
    private readonly workflows: BookingWorkflowRepository,
  ) {}

  /** The single source of truth for the current orchestration mode, read the same way. */
  private activeMode(): boolean {
    return (
      this.config.get<boolean>('BOOKING_ORCHESTRATOR_ENABLED') === true &&
      this.config.get<string>('BOOKING_ORCHESTRATOR_MODE', 'shadow') === 'active'
    );
  }

  /**
   * Read a booking with the guest checkout session that is still in the browser.
   *
   * ── WHY THE HEADER IS CHECKED BEFORE THE BOOKING IS LOADED ─────────────────────────
   * The same order `POST /bookings/guest/:id/pay` uses: a well-formed session token is the
   * price of asking the question at all, in EVERY orchestration mode. Loading first and
   * checking after would answer "does this booking id exist" to anybody who guesses one, which
   * is a different leak from the one this route is about but a leak all the same.
   *
   * In active mode the token is then matched against the workflow's durable owner, so a guest
   * cannot read a booking merely because they hold *some* valid session. In the other modes no
   * workflow exists to match against; the well-formedness check plus the 404 below are what
   * there is, which is the same guarantee the guest payment route has always given.
   */
  async viewBySession(
    bookingId: string,
    anonymousToken: string | undefined,
  ): Promise<GuestBookingView> {
    if (!this.anon.isWellFormed(anonymousToken)) {
      throw new AppException(
        ErrorCodes.UNAUTHORIZED,
        'A valid guest checkout session is required.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (this.activeMode()) {
      const workflow = await this.workflows.getByBookingId(bookingId);
      if (workflow) {
        this.owners.assertOwner(
          workflow,
          this.owners.resolveForRequest({ user: null, anonymousToken }),
        );
      }
    }
    const booking = await this.loadGuestBooking({ id: bookingId });
    return this.toView(booking, null);
  }

  /**
   * Read a booking with a link that was emailed to the address that paid.
   *
   * ── WHY EVERY FAILURE IS THE SAME 404 ──────────────────────────────────────────────
   * Unknown, expired and superseded are all "this link does not open anything", and the caller
   * is anonymous. A 401 would say "that is a real token, just not a live one" — which tells
   * somebody spraying tokens that they are in the right shape, and tells somebody holding an
   * old forwarded link that the booking behind it exists. Neither reader is owed either fact,
   * and the person who legitimately has an expired link needs one sentence and the lookup form,
   * not a status code.
   */
  async viewByAccessToken(rawToken: string): Promise<GuestBookingView> {
    const notFound = () =>
      new AppException(ErrorCodes.NOT_FOUND, 'Booking not found.', HttpStatus.NOT_FOUND);

    const trimmed = (rawToken ?? '').trim();
    if (!trimmed) throw notFound();

    const access = await this.prisma.guestBookingAccess.findUnique({
      where: { tokenHash: hashGuestAccessToken(trimmed) },
      select: { id: true, bookingId: true, expiresAt: true, tokenHash: true },
    });
    /*
      The row was found BY the hash, so this comparison cannot fail — which is the point of
      making it anyway. It is the assertion that the credential presented is the credential
      stored, written where a future change to how the row is located (a scan, a join, a cache)
      would otherwise quietly remove the guarantee. Constant-time, so it never becomes an
      oracle for how much of a token was right.
    */
    if (access && !guestAccessTokenMatches(trimmed, access.tokenHash)) throw notFound();
    /*
      A superseded token needs no check of its own: issuing a new link DELETES the old rows, so
      an old token simply has no row. Expiry is the only live-token condition left.
    */
    if (!access || access.expiresAt.getTime() <= Date.now()) throw notFound();

    const booking = await this.loadGuestBooking({ id: access.bookingId });

    /*
      Count the open AFTER the booking is known to be readable, so a 404 does not leave a
      record of somebody's failed attempt on a row they never reached. Best-effort: a guest
      whose ticket loads must not be handed an error because a counter could not be bumped.
    */
    await this.prisma.guestBookingAccess
      .update({
        where: { id: access.id },
        data: { openCount: { increment: 1 }, lastOpenedAt: new Date() },
      })
      .catch(() => undefined);

    return this.toView(booking, access.expiresAt);
  }

  /**
   * Email a fresh link to somebody who can name their reference and the address they used.
   *
   * ── WHY THE ANSWER IS ALWAYS THE SAME ──────────────────────────────────────────────
   * Unauthenticated, and it takes two things somebody merely typed. If it answered differently
   * for a match and a miss it would be a free tool for confirming that an address bought
   * tickets — and on a ticketing platform, who went to what. The password-reset route reached
   * the same conclusion for the same reason; this one additionally levels the TIMING, because
   * here the matching path does noticeably more work than the miss.
   *
   * ── AND WHY THE LINK IS NEVER RETURNED ─────────────────────────────────────────────
   * It is a bearer credential for somebody else's tickets. The only place it belongs is the
   * inbox of the address that paid, which is the one place the requester has to already control
   * in order to benefit. Handing it back in the response would make the reference the entire
   * secret.
   */
  async requestAccessLink(input: { reference: string; email: string }): Promise<{ sent: true }> {
    const startedAt = Date.now();
    const reference = input.reference.trim();
    const email = input.email.trim();

    try {
      if (!reference || !email) return { sent: true };

      const booking = await this.prisma.booking.findFirst({
        where: {
          // Case-insensitive on both: a reference is read off a screen or down a phone, and an
          // address is typed. Neither is a password and neither should be treated like one.
          reference: { equals: reference, mode: 'insensitive' },
          buyerEmail: { equals: email, mode: 'insensitive' },
          /*
            An account booking is never recoverable this way. Its owner has a password and a
            wallet; emailing a link that bypasses both would turn "I know your reference and
            your address" into a way into an account's tickets.
          */
          userId: null,
        },
        select: {
          id: true,
          buyerEmail: true,
          createdAt: true,
          organizationId: true,
          // The show's start sets how long the link lives, so it is read with the booking.
          eventSession: { select: { startsAt: true } },
        },
      });
      if (!booking) return { sent: true };

      /*
        Mint and enqueue in ONE transaction. Split, a crash between them either mails a link
        that was rolled back or supersedes the customer's working link and tells nobody.
      */
      await this.prisma.$transaction(async (tx) => {
        const { token } = await issueGuestAccessToken(tx, {
          bookingId: booking.id,
          showStartsAt: booking.eventSession?.startsAt ?? null,
        });
        await this.notifications.send(
          {
            type: NotificationType.GUEST_BOOKING_ACCESS,
            // No account exists, so there is no inbox to file this in — the address is the
            // only recipient there is.
            userId: null,
            toEmail: booking.buyerEmail,
            bookingId: booking.id,
            payload: { link: guestAccessLink(this.config, token) },
          },
          tx,
        );
      });

      return { sent: true };
    } finally {
      await this.settleLookupTiming(startedAt);
    }
  }

  /** Waits out the remainder of the fixed budget; see {@link LOOKUP_FLOOR_MS}. */
  private async settleLookupTiming(startedAt: number): Promise<void> {
    const remaining = LOOKUP_FLOOR_MS - (Date.now() - startedAt);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  }

  /**
   * Load a booking that a guest route may return, or 404.
   *
   * ── WHY `userId: null` IS IN THE QUERY AND NOT AN `if` AFTERWARDS ───────────────────
   * Because then there is no code path on which an account booking has been read into memory
   * inside a request that is about to be answered to an anonymous caller. The check cannot be
   * skipped by a future reader adding a second call site, and the 404 is produced by the same
   * statement that produces a genuinely missing booking — so the two are indistinguishable
   * from outside, which is the point: whether a reference belongs to an account is not
   * something a guest route should confirm.
   */
  private async loadGuestBooking(where: { id: string }): Promise<BookingForView> {
    const booking = await this.prisma.booking.findFirst({
      where: { ...where, userId: null },
      select: VIEW_SELECT,
    });
    if (!booking) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Booking not found.', HttpStatus.NOT_FOUND);
    }
    return booking as unknown as BookingForView;
  }

  private async toView(
    booking: BookingForView,
    accessExpiresAt: Date | null,
  ): Promise<GuestBookingView> {
    /*
      ── WHY THE QR IS FETCHED ONLY FOR A CONFIRMED BOOKING ──────────────────────────
      A QR opens a gate. Before confirmation there is nothing to admit, so rather than mint a
      credential and then remember to strip it out of the response, the credential is never
      minted: the decorated read — the one place QR payloads are signed — is not called at all.
      A code that does not exist cannot leak through a later refactor of this method.

      `TicketsService` stays the only signer. Signing here would be a second place a gate
      credential is produced, and the transferred-ticket rule lives in the first one.
    */
    const confirmed = booking.status === BookingStatus.CONFIRMED;
    const presented = confirmed ? await this.tickets.ticketsForGuestBooking(booking.id) : [];
    const byTicketId = new Map(presented.map((t) => [t.id, t]));

    const screen = booking.eventSession?.screen ?? null;
    const startsAt = booking.eventSession?.startsAt ?? null;

    return {
      id: booking.id,
      reference: booking.reference,
      status: booking.status,
      currency: booking.currency,
      holdExpiresAt: iso(booking.holdExpiresAt),
      event: {
        title: booking.event.title,
        slug: booking.event.slug,
        startsAt: iso(startsAt) ?? '',
        // Cinema first — a screen's own zone is the most specific fact about where it plays —
        // then the venue, by the same rule the confirmation email and the ticket face use, so
        // the three cannot disagree about when the show starts.
        timeZone: screen?.cinema?.timezone ?? booking.event.venue?.timezone ?? null,
        venueName: booking.event.venue?.name ?? null,
        cinemaName: screen?.cinema?.name ?? null,
        screenName: screen?.name ?? null,
      },
      buyer: { name: booking.buyerName, emailMasked: maskEmail(booking.buyerEmail) },
      /*
        Read, never recalculated. `feesMinor` is the customer's own fee column — not the
        organizer's share and not the platform's revenue, neither of which is any of this
        reader's business, and both of which would make these four numbers fail to add up to
        what the card was charged.
      */
      totals: {
        subtotalMinor: booking.subtotalMinor,
        feesMinor: booking.customerFeeMinor,
        taxMinor: booking.taxMinor,
        totalMinor: booking.totalMinor,
      },
      items: booking.items.map((item) => ({
        label:
          item.label ?? item.ticketType?.name ?? item.addOn?.name ?? item.bundle?.name ?? 'Ticket',
        quantity: item.quantity,
        unitPriceMinor: item.unitPriceMinor,
        seatLabel: this.seatLabelForItem(booking, item),
      })),
      tickets: booking.tickets.map((ticket) => {
        const decorated = byTicketId.get(ticket.id);
        return {
          id: ticket.id,
          seatLabel: seatLabelOf(ticket),
          ticketTypeName: ticket.ticketType?.name ?? null,
          // Null before confirmation, and null for a ticket that has been transferred away —
          // `TicketsService` decides the second one, and it is not re-decided here.
          qrToken: decorated?.qrToken ?? null,
          qrDataUrl: decorated?.qrDataUrl ?? null,
          checkedInAt: iso(ticket.checkIns[0]?.createdAt ?? null),
        };
      }),
      accessExpiresAt: iso(accessExpiresAt),
    };
  }

  /**
   * The seat a price line is for, when it is for exactly one.
   *
   * ── WHY THIS IS USUALLY NULL ────────────────────────────────────────────────────────
   * A `BookingItem` is a PRICE line — a ticket type and a quantity — not a seat. Four stalls
   * seats at one price are one row, so there is no single seat label to give it, and joining
   * four labels into a field named `seatLabel` would put a list where a client reasonably
   * expects a value. The definitive per-seat list is `tickets`, which has one entry per seat.
   *
   * The one case worth filling in is the common one: a single seat bought at its own price,
   * where the line and the seat are the same thing and the customer would otherwise see their
   * order listed without the seat they chose.
   */
  private seatLabelForItem(
    booking: BookingForView,
    item: { quantity: number; ticketTypeId: string | null },
  ): string | null {
    if (item.quantity !== 1 || !item.ticketTypeId) return null;
    const forType = booking.tickets.filter((t) => t.ticketTypeId === item.ticketTypeId);
    if (forType.length !== 1) return null;
    return seatLabelOf(forType[0]);
  }
}

/** A ticket's own label, or the seat it is bound to. Both exist; the snapshot wins. */
function seatLabelOf(ticket: {
  seatLabel: string | null;
  seat: { label: string; row: { label: string } } | null;
}): string | null {
  return ticket.seatLabel ?? (ticket.seat ? `${ticket.seat.row.label}${ticket.seat.label}` : null);
}

/** Dates cross the wire as ISO strings, so the shape is the same on both sides. */
function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}
