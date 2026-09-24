import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import {
  BookingStatus,
  NotificationType,
  type GuestBookingClaim,
  type GuestBookingView,
  type GuestReceiptsView,
} from '@eticketsgo/shared-types';
import { resolveLocale } from '@eticketsgo/i18n';
import { feeTaxSummary } from '../pricing/fee-tax';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from '../notifications/notification.service';
import { TicketsService } from '../tickets/tickets.service';
import { ReceiptsService } from '../receipts/receipts.service';
import { renderReceiptHtml } from '../receipts/receipt-html';
import { RefundsService } from '../refunds/refunds.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';
import { AnonymousSessionService } from './orchestration/booking-owner';
import { GuestSessionVerifier } from './guest-session';
import {
  guestAccessLink,
  guestAccessTokenMatches,
  guestEmailMatches,
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
  /*
    Read so the session check can be made, and never projected: `toView` enumerates its fields, so
    the hash cannot reach a response by being part of the row. It is a credential digest, and the
    one place it belongs is a comparison.
  */
  guestSessionHash: true,
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
  /*
    ── THE REST OF THE MONEY, SO THE COLUMN CAN ADD UP ──────────────────────────────
    A guest used to be sent four numbers - subtotal, fees, tax, total - and the screen printed
    them one under another. They cannot add up: an Indian ticket price is GST-inclusive, so
    `taxMinor` counts the tax already inside `subtotalMinor` as well as the tax added on the
    fees. A buyer read 499 + 20.18 + 79.76 against a total of 522.82 and reported it.

    These are the same fields the account holder's booking has always carried, so both screens
    can render through the one breakdown that knows an inclusive tax is a memo, not an addend.
  */
  discountMinor: true,
  bookingFeeMinor: true,
  paymentFeeMinor: true,
  maintenanceMinor: true,
  maintenanceTreatment: true,
  taxLines: {
    select: {
      label: true,
      rateBasisPoints: true,
      amountMinor: true,
      basis: true,
      inclusive: true,
    },
  },
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
      serial: true,
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
  guestSessionHash: string | null;
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
  // The rest of the money snapshot, so the guest's column can add up. See the select above.
  discountMinor: number;
  bookingFeeMinor: number;
  paymentFeeMinor: number;
  maintenanceMinor: number;
  maintenanceTreatment:
    'NOT_APPLICABLE' | 'INCLUDED_IN_TICKET_PRICE' | 'ADDED_TO_TICKET_PRICE' | 'UNCONFIRMED';
  taxLines: {
    label: string;
    rateBasisPoints: number;
    amountMinor: number;
    basis: string | null;
    inclusive: boolean | null;
  }[];
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
    serial: string;
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
    /*
      No `BookingOwnerResolver` and no workflow repository any more. `assertOwner` was how this
      service checked a guest session — against the workflow's durable owner, a row that exists
      only in ACTIVE mode, which no environment runs. The binding now lives on the booking, and the
      one implementation of that check is `GuestSessionVerifier`, shared with the guest PAYMENT
      route so the two cannot drift apart again. The resolver remains the router's, where
      request-time owner resolution belongs.
    */
    private readonly sessions: GuestSessionVerifier,
    // The documents and the refund rules are NOT reimplemented here. This service owns one
    // thing — deciding whether an anonymous caller may act on a booking — and then calls the
    // same services the account routes call. See `RefundsService.requestAsGuest`.
    private readonly receipts: ReceiptsService,
    private readonly refunds: RefundsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Read a booking with the guest checkout session that is still in the browser.
   *
   * ── WHY THE HEADER IS CHECKED BEFORE THE BOOKING IS LOADED ─────────────────────────
   * The same order `POST /bookings/guest/:id/pay` uses: a well-formed session token is the
   * price of asking the question at all, in EVERY orchestration mode. Loading first and
   * checking after would answer "does this booking id exist" to anybody who guesses one, which
   * is a different leak from the one this route is about but a leak all the same.
   *
   * ── AND WHAT THE TOKEN IS THEN MATCHED AGAINST ─────────────────────────────────────
   * The session hash the booking itself carries, written when it was created in EVERY mode — see
   * {@link GuestSessionVerifier}. Before that column existed this check was only made in active
   * mode, against the workflow's durable owner, and no environment runs active mode: possession of
   * a booking id was effectively the whole check, because any well-formed token was accepted.
   *
   * A booking with NO binding is still read on a well-formed token. That is the behaviour every
   * environment already had, and refusing it would lock somebody who bought before the column
   * existed out of the tickets they paid for. The claim route refuses the same case, because
   * adopting a booking is permanent and a read is not.
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
    const booking = await this.loadGuestBooking({ id: bookingId });
    // `UNBOUND` is accepted here and refused on the claim; `null` is a token that contradicts a
    // binding the booking does carry, and that is refused everywhere.
    if ((await this.sessions.verify(booking, anonymousToken)) === null) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'This booking was not started in this browser.',
        HttpStatus.FORBIDDEN,
      );
    }
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
    const access = await this.liveAccess(rawToken);
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

  /** The 404 every unopenable link gets, whatever is wrong with it. */
  private linkOpensNothing(): AppException {
    return new AppException(ErrorCodes.NOT_FOUND, 'Booking not found.', HttpStatus.NOT_FOUND);
  }

  /**
   * The live access row for a raw token, or the one 404.
   *
   * Extracted so that the read route, the receipt route and the refund route cannot diverge on
   * what makes a link valid — an expiry check that exists on two of three routes is a link that
   * keeps working for the third one forever.
   */
  private async liveAccess(
    rawToken: string,
  ): Promise<{ id: string; bookingId: string; expiresAt: Date }> {
    const trimmed = (rawToken ?? '').trim();
    if (!trimmed) throw this.linkOpensNothing();

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
    if (access && !guestAccessTokenMatches(trimmed, access.tokenHash))
      throw this.linkOpensNothing();
    /*
      A superseded token needs no check of its own: issuing a new link DELETES the old rows, so
      an old token simply has no row. Expiry is the only live-token condition left.
    */
    if (!access || access.expiresAt.getTime() <= Date.now()) throw this.linkOpensNothing();
    return { id: access.id, bookingId: access.bookingId, expiresAt: access.expiresAt };
  }

  /**
   * The gate on everything that is money or paperwork: the link, and then the address.
   *
   * ── WHY TWO PROOFS AND NOT ONE ─────────────────────────────────────────────────────
   * The link is forwardable and is MEANT to be — that is how a friend finds their seat and how
   * a ticket reaches somebody's second phone. It therefore cannot be the only thing standing
   * between a stranger and an invoice with the buyer's name on it, or a request that empties
   * the buyer's booking back onto their card. So the link proves which booking, and the address
   * the booking was PAID with proves who is asking.
   *
   * The buyer types it in three seconds. Somebody holding a forwarded link cannot: the view
   * they were given shows two characters and a domain, on purpose.
   *
   * ── WHAT THE REFUSALS SAY ──────────────────────────────────────────────────────────
   * A bad or dead link is the same 404 the read route gives, for the reasons above it. A wrong
   * address is a 403 and says so plainly: the caller has already proven they hold a live link
   * to a real booking, so refusing them a status code tells them nothing they do not have, and
   * a real buyer who mistyped needs to be told it was the address.
   */
  private async provenByLinkAndEmail(
    rawToken: string,
    email: string,
  ): Promise<{ id: string; organizationId: string; buyerEmail: string }> {
    const access = await this.liveAccess(rawToken);
    /*
      `userId: null` in the WHERE clause, exactly as `loadGuestBooking` does it and for the same
      reason — plus one that is specific to these routes: an access row OUTLIVES a claim. Once a
      booking has been attached to an account, its emailed link must stop being able to pull the
      buyer's invoice or move their money, and the way to guarantee that is for the statement
      that finds the booking to be unable to find one with an owner.
    */
    const booking = await this.prisma.booking.findFirst({
      where: { id: access.bookingId, userId: null },
      select: { id: true, organizationId: true, buyerEmail: true },
    });
    if (!booking) throw this.linkOpensNothing();

    if (!guestEmailMatches(email, booking.buyerEmail)) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'That is not the email address this booking was paid with.',
        HttpStatus.FORBIDDEN,
      );
    }
    return booking;
  }

  /**
   * The financial documents for a guest's own booking.
   *
   * ── WHY THE RENDERING IS NOT DONE HERE ─────────────────────────────────────────────
   * `renderReceiptHtml` is the one renderer, and the document it renders is the frozen snapshot
   * the platform issued — never a recomputation. A second renderer for guests would be a second
   * thing that can disagree with the organizer's books about an amount, and a receipt that
   * disagrees with the card statement is worse than no receipt.
   *
   * ── WHY AN EMPTY ANSWER IS NOT AN ERROR ────────────────────────────────────────────
   * A confirmed, paid booking has its sale document issued in the same transaction that
   * confirms it, so the common case always has one. But a free booking has no sale to document
   * and an unpaid one has nothing to show, and neither is a fault the buyer can act on. An
   * empty list says "nothing to show yet"; a 404 would say "we have lost your invoice".
   */
  async receiptsByAccessToken(
    rawToken: string,
    input: { email: string; locale?: string | null; acceptLanguage?: string | null },
  ): Promise<GuestReceiptsView> {
    const booking = await this.provenByLinkAndEmail(rawToken, input.email);
    const issued = await this.receipts.listForBooking(booking.id);

    const documents = issued.map((row) => ({
      id: row.id,
      kind: String(row.kind),
      number: row.number,
      issuedAt: row.issuedAt.toISOString(),
      totalMinor: row.totalMinor,
      currency: row.currency,
    }));
    if (documents.length === 0) return { documents: [], html: '' };

    /*
      The SALE document is the primary one — the invoice or receipt for what was bought. Credit
      notes are listed alongside it and are never the primary: a booking that has been partly
      refunded would otherwise render its credit note as "your receipt", which states a negative
      total and names none of the tickets the customer still holds.

      `listForBooking` is oldest-first, so the first non-credit-note row is the original sale.
    */
    const primary = issued.find((row) => String(row.kind) !== 'CREDIT_NOTE') ?? issued[0];
    const { document } = await this.receipts.document(primary.id);

    /*
      Which language the document is written in. A guest has no stored preference — there is no
      account to hold one — so it is whatever the page asked for, then the browser's header,
      then the default. Re-derived per request, like the account route: a receipt is a rendering
      of stored facts and not a stored rendering, and the AMOUNTS come from the document.
    */
    const locale = resolveLocale({
      stored: input.locale ?? null,
      acceptLanguage: input.acceptLanguage ?? null,
    });

    /*
      Audited, unlike the plain read. A financial document names the buyer, their address and an
      amount, and it was just handed to a caller with no account — so who pulled which document,
      and when, is the only trail there is. The metadata carries ids and nothing else: never the
      token, never the address.
    */
    await this.audit.record({
      actorUserId: null,
      organizationId: booking.organizationId,
      action: 'GUEST_RECEIPT_VIEWED',
      entityType: 'Receipt',
      entityId: primary.id,
      metadata: { bookingId: booking.id, via: 'GUEST_ACCESS_LINK' },
    });

    return { documents, html: renderReceiptHtml(document, locale) };
  }

  /**
   * A refund, asked for by the buyer through their emailed link.
   *
   * ── WHY THERE IS SO LITTLE HERE ────────────────────────────────────────────────────
   * This method is the authorisation and nothing else. Whether a refund may happen at all — the
   * organizer's cutoff, the cash refusal, what is left of the refundable balance, the
   * per-booking lock that stops two requests paying out twice — is decided by the SAME body the
   * account route goes through, in `RefundsService`. A guest refund therefore lands in exactly
   * the state an account refund lands in, in the same organizer queue, and an organizer changing
   * their refund terms cannot find the change applying to one door and not the other.
   */
  async requestRefundByAccessToken(rawToken: string, input: { email: string; reason?: string }) {
    const booking = await this.provenByLinkAndEmail(rawToken, input.email);
    /*
      A reason is required on the stored refund and optional in this request, so a guest who
      types nothing gets a plain, true sentence rather than an empty column. Not the customer's
      words attributed to them when they said none.
    */
    const reason = (input.reason ?? '').trim() || 'Requested by the buyer, who has no account.';
    return this.refunds.requestAsGuest({ bookingId: booking.id, reason });
  }

  /**
   * Attach a booking bought without an account to the account that is now signed in.
   *
   * ── WHAT PROVES THE CALLER MAY ADOPT IT ────────────────────────────────────────────
   * Either of the two things a guest can legitimately hold, and nothing else: the checkout
   * session that bought it (`x-anon-session`, matched against the workflow's durable owner), or
   * a live access link to it. A booking id alone proves nothing — it is a cuid in a URL — and
   * accepting one would let anybody walk ids and adopt other people's tickets.
   *
   * ── WHY A SESSION TOKEN IS ONLY PROOF WHEN A WORKFLOW SAYS SO ──────────────────────
   * The anonymous token is bound to a booking by the orchestration workflow and by nothing
   * else. With the orchestrator disabled or in shadow mode no such row exists, so there is
   * nothing to match the token against — and a well-formed token is something the caller can
   * mint for themselves. `POST /bookings/guest/:id/cancel` refuses guests on that path for
   * precisely this reason; here the caller is told to use their emailed link instead, which
   * genuinely is bound to the booking.
   *
   * ── AND WHY AN EXISTING OWNER IS NEVER DISPLACED ───────────────────────────────────
   * The write is conditional on `userId: null`, so the database — not a read a moment earlier —
   * decides. Two callers claiming at once cannot both win, and a booking that already belongs
   * to somebody is a 409 rather than a silent change of ownership. Re-claiming one the caller
   * already owns is a 200 with no write at all, because a client that retries a request it did
   * not see the answer to must not be punished for it.
   */
  async claim(input: {
    bookingId: string;
    user: RequestUser;
    accessToken?: string | null;
    anonymousToken?: string | null;
  }): Promise<GuestBookingClaim> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: input.bookingId },
      select: { id: true, userId: true, organizationId: true, guestSessionHash: true },
    });
    if (!booking) throw this.linkOpensNothing();

    // Already theirs. Idempotent, and no proof is asked for: owning it IS the proof, and a
    // client whose guest session has since been cleared would otherwise be refused its own
    // booking on a retry.
    if (booking.userId === input.user.id) return { bookingId: booking.id, claimed: true };

    const proof = await this.proofOfGuestControl(booking, input);
    if (!proof) {
      /*
        The message names the way forward, because for one class of refusal there genuinely is one.
        A booking that records no session — created before that column existed — cannot be claimed
        with a session token at all, deliberately; but its buyer has a link in their confirmation
        email, and that link IS accepted here. Telling somebody only "forbidden" would leave them
        stuck in front of a booking they own.
      */
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'This booking cannot be added to your account. Open it from the link in your confirmation email and try again.',
        HttpStatus.FORBIDDEN,
      );
    }

    /*
      Checked AFTER the proof, deliberately. Answering 409 first would confirm "this booking id
      exists and belongs to an account" to anybody posting guessed ids, which is the one fact a
      route reachable by id should not volunteer.
    */
    if (booking.userId !== null) throw this.alreadyOwned();

    const claimed = await this.prisma.$transaction(async (tx) => {
      const write = await tx.booking.updateMany({
        // `userId: null` in the WHERE clause is what makes this safe under a race: the row is
        // claimed only if it is still unclaimed, decided by the database.
        where: { id: booking.id, userId: null },
        data: { userId: input.user.id },
      });
      if (write.count !== 1) return false;
      /*
        The emailed links are spent by the claim.

        A guest access token is a forwardable bearer credential, and `requestAccessLink` already
        refuses to mint one for a booking that has an owner — for the good reason that it would
        turn "I know a reference and an address" into a way into an account's tickets. A link
        that was minted BEFORE the claim is the same credential, so it goes at the moment the
        booking stops being a guest booking. Without this the read route would still 404 (it
        filters `userId: null`), but the row would sit there as a credential waiting for a future
        route to honour.
      */
      await tx.guestBookingAccess.deleteMany({ where: { bookingId: booking.id } });
      return true;
    });

    if (!claimed) {
      /*
        Somebody else got there in between. Re-read to tell the two cases apart: the same
        account claiming twice concurrently is still idempotent, and anybody else is a conflict.
      */
      const now = await this.prisma.booking.findUnique({
        where: { id: booking.id },
        select: { userId: true },
      });
      if (now?.userId === input.user.id) return { bookingId: booking.id, claimed: true };
      throw this.alreadyOwned();
    }

    await this.audit.record({
      actorUserId: input.user.id,
      organizationId: booking.organizationId,
      action: 'GUEST_BOOKING_CLAIMED',
      entityType: 'Booking',
      entityId: booking.id,
      // Which of the two proofs was used, and nothing that could identify either credential.
      metadata: { proof },
    });

    return { bookingId: booking.id, claimed: true };
  }

  /** An existing owner is never displaced; the caller is told plainly why not. */
  private alreadyOwned(): AppException {
    return new AppException(
      ErrorCodes.CONFLICT,
      'This booking already belongs to an account.',
      HttpStatus.CONFLICT,
    );
  }

  /**
   * Which proof of guest control the caller presented, or null for none.
   *
   * Neither branch throws: a caller may legitimately send both — a browser that still has its
   * checkout session, opening a link from the email — and a failing first proof must not refuse
   * a request the second one would have allowed.
   */
  private async proofOfGuestControl(
    booking: { id: string; guestSessionHash: string | null },
    input: { accessToken?: string | null; anonymousToken?: string | null },
  ): Promise<'ACCESS_LINK' | 'GUEST_SESSION' | null> {
    const raw = (input.accessToken ?? '').trim();
    if (raw) {
      const access = await this.prisma.guestBookingAccess.findUnique({
        where: { tokenHash: hashGuestAccessToken(raw) },
        select: { bookingId: true, expiresAt: true, tokenHash: true },
      });
      if (
        access &&
        guestAccessTokenMatches(raw, access.tokenHash) &&
        access.expiresAt.getTime() > Date.now() &&
        // A live link to a DIFFERENT booking is not proof about this one.
        access.bookingId === booking.id
      ) {
        return 'ACCESS_LINK';
      }
    }

    /*
      The same verifier the read route uses — see {@link GuestSessionVerifier} — read STRICTLY.

      It used to be the workflow owner and only the workflow owner, which was right about what
      binds a token to a booking and wrong about where that binding lives: the workflow row exists
      only in ACTIVE mode, and no environment runs active mode. So the browser that had just
      bought the booking was refused when it tried to claim it, and "save this to my account"
      could not succeed anywhere. The binding is now on the booking, written in every mode.

      ── WHY ONLY `BOUND` COUNTS HERE, WHERE A READ ACCEPTS `UNBOUND` ─────────────────
      Because a claim is permanent and it takes tickets away from somebody. On a booking that
      records no session, accepting a well-formed token would mean a booking id plus 256 bits the
      caller generated themselves is enough to adopt a stranger's booking — and unlike a read,
      there is no undoing it. Those callers are not stuck: the link in their confirmation email is
      a proof that genuinely exists for them, it is checked above, and the refusal says so.
    */
    if (
      this.anon.isWellFormed(input.anonymousToken) &&
      (await this.sessions.verify(booking, input.anonymousToken)) === 'BOUND'
    ) {
      return 'GUEST_SESSION';
    }
    return null;
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
        reader's business.

        `feeTaxSummary` splits the stored tax lines into the part levied ON the fees, which is
        an addend, and leaves the rest where it belongs: inside the ticket price. It is the same
        call the account holder's booking makes, so the two screens cannot disagree about what
        was charged.
      */
      totals: {
        subtotalMinor: booking.subtotalMinor,
        feesMinor: booking.customerFeeMinor,
        taxMinor: booking.taxMinor,
        totalMinor: booking.totalMinor,
        discountMinor: booking.discountMinor,
        bookingFeeMinor: booking.bookingFeeMinor,
        paymentFeeMinor: booking.paymentFeeMinor,
        maintenanceMinor: booking.maintenanceMinor,
        maintenanceTreatment: booking.maintenanceTreatment,
        taxLines: booking.taxLines.map((line) => ({
          label: line.label,
          rateBasisPoints: line.rateBasisPoints,
          amountMinor: line.amountMinor,
        })),
        ...feeTaxSummary(booking.taxLines, booking.customerFeeMinor),
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
          // Printed on the ticket, and what the door types in when a QR will not scan.
          serial: ticket.serial,
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
