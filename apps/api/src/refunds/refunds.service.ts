import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AdminPermission,
  BookingStatus,
  NotificationType,
  PaymentStatus,
  RefundStatus,
  Role,
  TicketStatus,
} from '@eticketsgo/shared-types';
import type { RefundRequestInput } from '@eticketsgo/validation';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';
import { ReceiptsService } from '../receipts/receipts.service';
import { InventoryService } from '../inventory/inventory.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { AppException, ErrorCodes } from '../common/errors';
import { checkRefundEligibility } from './refund-eligibility';
import { refundTax, ticketNetPrices } from './refund-tax';
import { ACCEPTED_TRANSFERS, currentHolderUserId, isTransferred } from '../tickets/ticket-holder';
import type { RequestUser } from '../common/decorators';
import { MetricsService } from '../metrics/metrics.service';
import { groupScopeWhere, type GroupScope } from '../admin/group-scope';

/** Refund rows that hold or consume a ticket's refund allocation. */
const OPEN_REFUND_STATUSES = [
  RefundStatus.REQUESTED,
  RefundStatus.PROCESSING,
  RefundStatus.COMPLETED,
] as const;

/**
 * Everything a refund request has to read off the booking, in one place.
 *
 * Named rather than inlined because two entry points now load it — the account route and the
 * guest access link — and the eligibility body below depends on every relation being present.
 * A second, slightly different `include` at the guest entry is how a check silently stops
 * being made: `tickets.invites` missing makes every ticket read as never transferred, and
 * `taxLines` missing makes a refund return the ticket price and keep the tax.
 */
const REFUND_BOOKING_INCLUDE = {
  // The organizer's policy travels with the booking, so eligibility is decided by
  // their terms rather than by a constant in platform code.
  eventSession: { select: { startsAt: true } },
  event: { select: { refundsEnabled: true, refundCutoffHours: true } },
  // Accepted transfers travel with each ticket, so the refund can tell whose it is now.
  tickets: { include: { invites: ACCEPTED_TRANSFERS } },
  taxLines: true,
} satisfies Prisma.BookingInclude;

type BookingForRefund = Prisma.BookingGetPayload<{ include: typeof REFUND_BOOKING_INCLUDE }>;

/**
 * Who is asking for a refund, and what their asking has already proven.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * Guest self-service needed a second door into the refund request, and the dangerous way to
 * build it is a second copy of the rules: the organizer's cutoff, the cash refusal, the
 * transferred-ticket rule, the per-booking lock, the "never more than was paid" ceiling. Two
 * copies drift, and the copy that drifts is the one nobody looks at — so the rules stayed in
 * ONE body and everything that differs between an account and a link-holder was pushed out
 * into this shape.
 *
 * Nothing here decides whether the caller is allowed to ask. That is settled at the door:
 * `request` checks booking ownership, and the guest entry is only reached after a live access
 * token AND the address the booking was paid with have both been proven.
 */
interface RefundRequester {
  /**
   * The account recorded as having asked, or null for a guest.
   *
   * Null is a fact, not a gap: a guest booking has no account behind it, so there is no user
   * id to name and inventing one would put a stranger's id on somebody else's refund.
   */
  userId: string | null;
  /** Platform staff act on the booking as a whole; a customer acts on their own tickets. */
  staff: boolean;
  /**
   * Whether this requester still holds a given ticket — the transferred-ticket rule, asked in
   * whichever way is correct for who is asking.
   *
   * A predicate rather than a user id, because the account path compares against a real id
   * while a guest has none, and `currentHolderUserId(...) === null` would read as "yes, the
   * caller holds it" for every ticket whose holder cannot be named. Fail-closed is the guest's
   * own predicate saying so explicitly.
   */
  holds: (ticket: { invites?: readonly { acceptedByUserId: string | null }[] }) => boolean;
  /** What the audit trail records about where the request came from. */
  via: 'ACCOUNT' | 'GUEST_ACCESS_LINK';
  /**
   * Whether to email the address that PAID that a refund has been requested.
   *
   * True only for a guest access link, and that is the whole reason the notice exists: a link
   * is forwardable, so the person asking may not be the person whose money it is. The buyer
   * finds out while it is still a request rather than when their tickets stop working.
   *
   * False for the account path, deliberately. A signed-in buyer asking for their own refund
   * already sees it in their wallet, and adding an email to a flow that has never sent one is a
   * product decision rather than a side effect of closing that hole.
   */
  notifyBuyer: boolean;
}

@Injectable()
export class RefundsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly inventory: InventoryService,
    private readonly access: OrgAccessService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly metrics: MetricsService,
    private readonly receipts: ReceiptsService,
  ) {}

  /** The booking a refund request is about, with everything the rules below read. */
  private async loadForRefund(bookingId: string): Promise<BookingForRefund> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: REFUND_BOOKING_INCLUDE,
    });
    if (!booking)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Booking not found.', HttpStatus.NOT_FOUND);
    return booking;
  }

  /**
   * A signed-in buyer (or platform staff) asking for a refund.
   *
   * This method is the OWNERSHIP check and nothing else. Every rule about whether a refund may
   * happen at all lives in {@link createRequest}, which the guest access-link entry calls too —
   * see {@link RefundRequester} for why that split exists.
   */
  async request(user: RequestUser, input: RefundRequestInput) {
    const booking = await this.loadForRefund(input.bookingId);
    if (booking.userId !== user.id && !this.access.isPlatformAdmin(user)) {
      /*
        The holder of a transferred ticket, told why rather than refused as a stranger.

        Found by QA: a recipient asking to refund a ticket they were given got "You cannot refund
        this booking." — true, but it reads as a fault. A refund returns money to the card that
        paid, which is the buyer's, so letting the recipient trigger it would void their ticket
        and pay somebody else. Refunds of transferred tickets therefore stay with the organizer,
        and the recipient is told so plainly.
      */
      const holdsATicket = booking.tickets.some(
        (t) => currentHolderUserId({ booking, invites: t.invites }) === user.id,
      );
      if (holdsATicket) {
        throw new AppException(
          ErrorCodes.REFUND_NOT_ELIGIBLE,
          'This ticket was transferred to you. Refunds for transferred tickets are handled by the organizer — please contact them.',
          HttpStatus.CONFLICT,
        );
      }
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'You cannot refund this booking.',
        HttpStatus.FORBIDDEN,
      );
    }

    return this.createRequest(
      {
        userId: user.id,
        staff: this.access.isPlatformAdmin(user),
        holds: (ticket) => currentHolderUserId({ booking, invites: ticket.invites }) === user.id,
        via: 'ACCOUNT',
        notifyBuyer: false,
      },
      booking,
      input,
    );
  }

  /**
   * A refund asked for by somebody holding a guest access link.
   *
   * ── WHAT PROVES THE CALLER MAY ASK ─────────────────────────────────────────────────
   * Not this method. Control is settled before it is called, in `GuestBookingService`: a live
   * access token AND the email address the booking was paid with, compared in constant time.
   * The emailed link is forwardable, so the link alone opens the tickets and never the money.
   *
   * ── AND WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────────
   * Any eligibility rule. This body is the two facts that differ from the account path — no
   * actor user id, and a guest holds every ticket that has not been transferred away — handed
   * to the same {@link createRequest} the account route uses. A guest refund therefore lands in
   * exactly the state an account refund lands in, in the same organizer queue, and a change to
   * the organizer's cutoff policy cannot apply to one door and not the other.
   */
  async requestAsGuest(input: RefundRequestInput) {
    const booking = await this.loadForRefund(input.bookingId);
    /*
      A booking with an owner is not a guest booking, whatever token was presented.

      Belt and braces: the guest service resolves the booking with `userId: null` in the WHERE
      clause, so this cannot normally be reached. It is here because an access-token row
      OUTLIVES a claim — the token is not deleted when the booking is attached to an account —
      and "the link stops moving money once the booking has an owner" must be true in the
      service that moves the money, not only in the one that reads it.
    */
    if (booking.userId !== null) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'This booking belongs to an account. Sign in to request a refund.',
        HttpStatus.FORBIDDEN,
      );
    }
    return this.createRequest(
      {
        userId: null,
        // A link-holder is never staff, whoever they are. Staff act through the admin console.
        staff: false,
        // A guest booking's tickets cannot be transferred (that needs two accounts), so this is
        // true for all of them — stated as the rule rather than assumed, so a ticket that somehow
        // HAS moved on is excluded rather than silently refunded to the wrong person.
        holds: (ticket) => !isTransferred({ booking, invites: ticket.invites }),
        via: 'GUEST_ACCESS_LINK',
        notifyBuyer: true,
      },
      booking,
      input,
    );
  }

  /**
   * Whether a refund may happen, and the refund row if it may. ONE copy, two doors.
   *
   * Everything from here down applied to account refunds before guest self-service existed and
   * applies unchanged: the cash refusal, the organizer's cutoff, the transferred-ticket rule,
   * the per-booking advisory lock, the refundable-balance ceiling, the free-booking branch.
   */
  private async createRequest(
    requester: RefundRequester,
    booking: BookingForRefund,
    input: RefundRequestInput,
  ) {
    /*
      Cash never passed through a gateway, so there is nothing online to send it back through.

      A cash booking has no Payment row, and an approved refund with no provider named went to
      the default provider — which on QA is the mock, and reports COMPLETED for money that was
      never returned. The money is in the venue's till; it goes back across the same counter.
    */
    if (booking.paymentMethod === 'CASH') {
      throw new AppException(
        ErrorCodes.REFUND_NOT_ELIGIBLE,
        'This booking was paid in cash at the venue. Cash refunds are handled at the venue, not online.',
        HttpStatus.CONFLICT,
      );
    }

    const eligibility = checkRefundEligibility({
      bookingStatus: booking.status as BookingStatus,
      sessionStartsAt: booking.eventSession.startsAt,
      now: new Date(),
      refundsEnabled: booking.event?.refundsEnabled,
      policyHours: booking.event?.refundCutoffHours,
    });
    if (!eligibility.eligible) {
      throw new AppException(
        ErrorCodes.REFUND_NOT_ELIGIBLE,
        eligibility.reason ?? 'Not eligible.',
        HttpStatus.CONFLICT,
      );
    }

    /*
      A ticket the buyer has transferred is no longer theirs to cash in.

      An accepted transfer moves the ticket to its recipient, but the booking still names the
      buyer — so the buyer could give a ticket away and then refund it, leaving the recipient
      holding a voided ticket and the buyer holding the money. For the buyer, only tickets they
      still hold are refundable, and naming one they gave away is refused outright rather than
      quietly dropped. Platform staff act on the booking as a whole and are not limited by it.
    */
    const actingAsStaff = requester.staff;
    const heldByCaller = (t: (typeof booking.tickets)[number]) => requester.holds(t);
    if (
      !actingAsStaff &&
      input.ticketIds?.length &&
      booking.tickets.some((t) => input.ticketIds!.includes(t.id) && !heldByCaller(t))
    ) {
      throw new AppException(
        ErrorCodes.REFUND_NOT_ELIGIBLE,
        'One or more of these tickets has been transferred to someone else and can no longer be refunded by you.',
        HttpStatus.CONFLICT,
      );
    }
    const ownTickets = actingAsStaff ? booking.tickets : booking.tickets.filter(heldByCaller);

    /*
      ── A FREE BOOKING IS CANCELLED, NOT REFUNDED ─────────────────────────────────────────
      A request on a booking that cost nothing used to create a ₹0 refund: a row in the
      organizer's queue and the platform's, asking somebody to approve returning no money, with
      the tickets still live and the seats still taken until they got round to it. There is
      nothing to decide and nothing to pay back, so the tickets are cancelled here and now.

      After every check above, deliberately. Whose tickets these are, the organizer's refund
      terms and how close the session is still decide what may be given back — being free
      changes only that no money moves.
    */
    if (booking.totalMinor === 0) {
      /*
        No REFUND_REQUESTED notice on this branch, and not by omission: nothing was requested.
        The tickets are cancelled here and now, so the message a buyer is owed is "your tickets
        were cancelled" — BOOKING_CANCELLED — which this path has never sent for anybody, guest
        or account. Sending a refund-request notice for a refund that will never exist would put
        a customer on hold waiting for money that was never taken.
      */
      return this.cancelFreeTickets(requester, booking, ownTickets, input);
    }

    const items = await this.prisma.bookingItem.findMany({ where: { bookingId: booking.id } });
    // What each ticket actually cost after the booking's discount — see `ticketNetPrices`.
    // Priced across EVERY ticket on the booking, transferred or not, so the shares still add up.
    const { netByTicket, bookingTicketsMinor } = ticketNetPrices(items, booking.tickets, booking);

    /*
      Reading the open refunds and creating this one are a single step per booking.

      Two requests for the same tickets arriving together both read "nothing covers these yet"
      and both created a refund; both could then be approved and paid. The advisory lock is
      keyed on the booking, so the second request waits for the first to commit and then sees
      its refund in `priorRefunds`. Scoped to the transaction, so it cannot be left held.
    */
    const refund = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`refund-request:${booking.id}`}))`;

      // Tickets already covered by an open (requested/processing/completed) refund
      // must not be refunded again.
      const priorRefunds = await tx.refund.findMany({
        where: { bookingId: booking.id, status: { in: [...OPEN_REFUND_STATUSES] } },
      });
      const alreadyCovered = new Set(priorRefunds.flatMap((r) => r.ticketIds));

      // Only ACTIVE/CHECKED_IN tickets are refundable — apply the status filter even
      // when the client supplies ticketIds (so already-refunded ids can't sneak in).
      const refundable = (
        input.ticketIds?.length
          ? ownTickets.filter((t) => input.ticketIds!.includes(t.id))
          : ownTickets
      ).filter(
        (t) =>
          (t.status === TicketStatus.ACTIVE || t.status === TicketStatus.CHECKED_IN) &&
          !alreadyCovered.has(t.id),
      );
      if (refundable.length === 0) {
        throw new AppException(
          ErrorCodes.REFUND_NOT_ELIGIBLE,
          'No refundable tickets in this booking.',
          HttpStatus.CONFLICT,
        );
      }
      const targetTickets = refundable;
      const ticketsMinor = targetTickets.reduce((s, t) => s + (netByTicket.get(t.id) ?? 0), 0);

      /*
      Tax charged on the tickets being returned goes back with them.

      Booking and payment fees do NOT — that is the platform's long-standing policy and this
      change does not touch it. Tax is different in kind: it was collected because a taxable
      supply happened, and undoing the supply undoes the reason for collecting it. Keeping it
      would mean the customer paid tax on a ticket they no longer hold.

      HOW it goes back depends on how it was charged — inside the ticket price or added to it,
      on the tickets or on the fees — which is decided per line in `refundTax`. Treating every
      line as added refunded Indian GST twice and refused the refund as exceeding the balance.
      Nothing here decides WHAT rate applies — that is TaxRule configuration, and with none
      active this whole block is zero.

      Both figures are after the discount, because tax was levied on the discounted price.
    */
      const tax = refundTax(booking.taxLines ?? [], ticketsMinor, bookingTicketsMinor);
      const taxMinor = tax.taxMinor;
      const amountMinor = ticketsMinor + tax.addedMinor;

      // Never let cumulative refunds exceed what was paid.
      const priorAmount = priorRefunds.reduce((s, r) => s + r.amountMinor, 0);
      if (priorAmount + amountMinor > booking.totalMinor) {
        throw new AppException(
          ErrorCodes.REFUND_NOT_ELIGIBLE,
          'Refund amount exceeds the remaining refundable balance.',
          HttpStatus.CONFLICT,
        );
      }

      const created = await tx.refund.create({
        data: {
          bookingId: booking.id,
          organizationId: booking.organizationId,
          amountMinor,
          taxMinor,
          /*
            The part of that tax which was ADDED to the price rather than sitting inside it.
            Recorded because it decides WHOSE money the refund returns: tax inside the ticket
            price was the organizer's revenue and comes off their settlement, while tax added
            on top was collected and kept by the platform. Zero in an inclusive-tax market.
          */
          taxAddedMinor: tax.addedMinor,
          reason: input.reason,
          status: RefundStatus.REQUESTED,
          ticketIds: targetTickets.map((t) => t.id),
          // Null for a guest: there is no account behind the booking to name as the requester.
          requestedByUserId: requester.userId,
        },
      });

      /*
        The buyer is told inside the transaction that records the request, for the reason the
        completion notice gives: "a refund was asked for" and "the person whose money it is
        knows a refund was asked for" must not be able to come apart. Enqueued after the commit,
        a crash in between leaves an unwanted request nobody was warned about.

        `refundId` is what separates one notice from the next — a booking can be refunded in
        parts, and two partial requests of the same amount are two real requests.
      */
      if (requester.notifyBuyer) {
        await this.notifications.sendCritical(tx, {
          type: NotificationType.REFUND_REQUESTED,
          // Null: a guest booking has no account, so there is no inbox to file it in. The
          // address that paid is the only recipient there is.
          userId: booking.userId,
          toEmail: booking.buyerEmail,
          bookingId: booking.id,
          payload: {
            bookingId: booking.id,
            refundId: created.id,
            reference: booking.reference ?? '',
            currency: booking.currency,
            amountMinor: created.amountMinor,
          },
        });
      }
      return created;
    });
    await this.audit.record({
      actorUserId: requester.userId,
      organizationId: booking.organizationId,
      action: 'REFUND_REQUESTED',
      entityType: 'Refund',
      entityId: refund.id,
      // `via` is the only record of WHERE the request came from. With no actor user id, a guest
      // refund is otherwise indistinguishable from a system-generated one in the audit trail —
      // and "somebody with the emailed link asked for this" is the fact a dispute turns on.
      metadata: { amountMinor: refund.amountMinor, via: requester.via },
    });
    return refund;
  }

  /**
   * Cancel tickets on a booking that cost nothing, at once, with no refund row.
   *
   * ── WHAT IT DOES INSTEAD OF A REFUND ──────────────────────────────────────────────
   * Everything a completed refund does to the tickets and nothing it does to money: the tickets
   * stop being valid, their seats and counters go back through the booking's own inventory
   * strategy, and a booking with nothing live left on it becomes CANCELLED. No Refund row, so no
   * ₹0 line in the organizer's queue, the platform's queue or a settlement report; no gateway;
   * no credit note against a sale of nothing.
   *
   * The tickets end CANCELLED rather than REFUNDED. Check-in refuses both alike, and "refunded"
   * on a ticket nobody paid for would be the one untrue word on the buyer's screen — and a
   * refund in every report that counts refunded tickets.
   *
   * ── EXACTLY ONCE ──────────────────────────────────────────────────────────────────
   * Under the same per-booking lock `request` takes, and claim-first: the conditional status
   * change on the tickets runs before any stock moves, and if it changes fewer tickets than it
   * was given — a concurrent cancellation, a check-in scan landing in between — the transaction
   * rolls back with nothing released. Stock only ever goes back for tickets this call voided.
   */
  private async cancelFreeTickets(
    requester: RefundRequester,
    booking: {
      id: string;
      organizationId: string;
      eventSessionId: string;
      seatBased: boolean;
      status: string;
    },
    ownTickets: { id: string; status: string; ticketTypeId: string; seatId: string | null }[],
    input: RefundRequestInput,
  ) {
    const LIVE: string[] = [TicketStatus.ACTIVE, TicketStatus.CHECKED_IN];
    const outcome = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`refund-request:${booking.id}`}))`;

      // A ticket an earlier request still covers — a ₹0 refund queued before this path existed,
      // say — stays with that request rather than being cancelled out from under it.
      const priorRefunds = await tx.refund.findMany({
        where: { bookingId: booking.id, status: { in: [...OPEN_REFUND_STATUSES] } },
        select: { ticketIds: true },
      });
      const alreadyCovered = new Set(priorRefunds.flatMap((r) => r.ticketIds));
      const targets = (
        input.ticketIds?.length
          ? ownTickets.filter((t) => input.ticketIds!.includes(t.id))
          : ownTickets
      ).filter((t) => LIVE.includes(t.status) && !alreadyCovered.has(t.id));
      if (targets.length === 0) {
        throw new AppException(
          ErrorCodes.REFUND_NOT_ELIGIBLE,
          'No tickets in this booking can be cancelled.',
          HttpStatus.CONFLICT,
        );
      }

      const claimed = await tx.ticket.updateMany({
        where: {
          id: { in: targets.map((t) => t.id) },
          status: { in: [TicketStatus.ACTIVE, TicketStatus.CHECKED_IN] },
        },
        data: { status: TicketStatus.CANCELLED },
      });
      if (claimed.count !== targets.length) {
        throw new AppException(
          ErrorCodes.CONFLICT,
          'Some of these tickets changed while they were being cancelled. Refresh and try again.',
          HttpStatus.CONFLICT,
        );
      }

      // The booking's own seating, so seats go back to the map they came from — as in `process`.
      await this.inventory.forSeating(booking.seatBased).refund(tx, {
        eventSessionId: booking.eventSessionId,
        tickets: targets.map((t) => ({ ticketTypeId: t.ticketTypeId, seatId: t.seatId })),
      });

      // Counted after the claim and inside the lock: the tickets read before it may be stale.
      const remaining = await tx.ticket.count({
        where: {
          bookingId: booking.id,
          status: { in: [TicketStatus.ACTIVE, TicketStatus.CHECKED_IN] },
        },
      });
      if (remaining === 0) {
        await tx.booking.update({
          where: { id: booking.id },
          data: { status: BookingStatus.CANCELLED, cancelledAt: new Date() },
        });
      }
      return {
        ticketIds: targets.map((t) => t.id),
        bookingStatus: remaining === 0 ? BookingStatus.CANCELLED : booking.status,
      };
    });

    await this.audit.record({
      actorUserId: requester.userId,
      organizationId: booking.organizationId,
      action: 'FREE_TICKETS_CANCELLED',
      entityType: 'Booking',
      entityId: booking.id,
      metadata: {
        ticketIds: outcome.ticketIds,
        bookingStatus: outcome.bookingStatus,
        reason: input.reason,
        via: requester.via,
      },
    });
    // `amountMinor` is the field a refund answer carries, stated as the zero it is, so a client
    // reading the result of a refund request sees correctly that nothing is owed.
    return {
      outcome: 'CANCELLED' as const,
      bookingId: booking.id,
      bookingStatus: outcome.bookingStatus,
      ticketIds: outcome.ticketIds,
      amountMinor: 0,
    };
  }

  async listForBookingOwner(user: RequestUser, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Booking not found.', HttpStatus.NOT_FOUND);
    if (booking.userId !== user.id && !this.access.isPlatformAdmin(user)) {
      throw new AppException(ErrorCodes.FORBIDDEN, 'Forbidden.', HttpStatus.FORBIDDEN);
    }
    return this.prisma.refund.findMany({ where: { bookingId }, orderBy: { createdAt: 'desc' } });
  }

  /**
   * The platform refund queue.
   *
   * Search reaches the database. It used to filter the fetched page in the browser, so a buyer
   * chasing their money was findable only if their request happened to be among the newest
   * fifteen - which is the opposite of who needs chasing.
   */
  async adminList(
    status: RefundStatus | undefined,
    page: number,
    pageSize: number,
    query?: string,
    scope: GroupScope = {},
  ) {
    const where: Prisma.RefundWhereInput = {
      /*
      Spread before the search so the scope cannot be overwritten by it. A list that quietly
      dropped its scope would show every row while the summary above it named one group.
    */
      ...groupScopeWhere('refunds', scope),
      ...(status ? { status } : {}),
      ...(query
        ? {
            OR: [
              { booking: { buyerEmail: { contains: query, mode: 'insensitive' } } },
              { booking: { reference: { contains: query, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [total, data] = await this.prisma.$transaction([
      this.prisma.refund.count({ where }),
      this.prisma.refund.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        // A Refund has no currency column; it is paid back in its booking's. Without it the
        // queue formatted every amount as rupees.
        include: {
          booking: {
            select: {
              buyerEmail: true,
              eventId: true,
              currency: true,
              reference: true,
              event: { select: { title: true } },
            },
          },
        },
      }),
    ]);
    return { data, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
  }

  /**
   * One refund from the platform queue, by id.
   *
   * The admin detail page used to look for the refund inside the newest hundred rows of the
   * list, so an older request — the ones most likely to need chasing — showed "not found".
   * Same shape as a list row, so the page reads it the same way.
   */
  async adminGet(refundId: string) {
    const refund = await this.prisma.refund.findUnique({
      where: { id: refundId },
      include: { booking: { select: { buyerEmail: true, eventId: true, currency: true } } },
    });
    if (!refund) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Refund not found.', HttpStatus.NOT_FOUND);
    }
    return refund;
  }

  /**
   * One organization's refunds.
   *
   * `adminList` above is deliberately unscoped — it is the platform's queue. An organizer
   * reaching for it would see every seller's refunds, so this is a separate query with the
   * tenant filter applied in the WHERE clause rather than after the fact. Membership is
   * asserted first, so a caller cannot read another organization's book by passing its id.
   *
   * Owners and managers only. A refund row carries the buyer's name and email and the money
   * returned to them; check-in staff scan tickets at the door and have no need to read either.
   */
  async listForOrganization(
    user: RequestUser,
    organizationId: string,
    opts: { status?: RefundStatus; page?: number; pageSize?: number } = {},
  ) {
    await this.access.assertMember(user, organizationId, [
      Role.ORGANIZER_OWNER,
      Role.ORGANIZER_MANAGER,
    ]);
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
    const where = { organizationId, ...(opts.status ? { status: opts.status } : {}) };
    const [total, data] = await this.prisma.$transaction([
      this.prisma.refund.count({ where }),
      this.prisma.refund.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          booking: {
            select: {
              id: true,
              reference: true,
              buyerName: true,
              buyerEmail: true,
              currency: true,
              totalMinor: true,
              event: { select: { title: true } },
            },
          },
          creditNote: { select: { id: true, number: true } },
        },
      }),
    ]);
    return { data, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
  }

  /** Admin (or organizer owner) decides a refund; on approval, money + tickets settle. */
  /**
   * Platform staff need REFUND_APPROVE to decide a refund.
   *
   * A super admin holds it by role. Everyone else needs the grant — which is the whole
   * point of the split: a refund desk can investigate a request and cannot pay it out.
   */
  private async assertMayApproveAsStaff(user: RequestUser) {
    if (user.roles.includes(Role.SUPER_ADMIN)) return;
    const held = await this.prisma.adminGrant.findFirst({
      where: { userId: user.id, permission: AdminPermission.REFUND_APPROVE },
      select: { id: true },
    });
    if (!held) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'Approving a refund needs the REFUND_APPROVE permission.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  async process(user: RequestUser, refundId: string, decision: 'APPROVE' | 'REJECT') {
    const refund = await this.prisma.refund.findUnique({ where: { id: refundId } });
    if (!refund)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Refund not found.', HttpStatus.NOT_FOUND);
    /*
      Two audiences, two different questions.

      An organizer refunding their own customer needs to own the booking — their money,
      their decision. A member of platform staff needs the REFUND_APPROVE capability, which
      the refund desk deliberately does not hold: reviewing a request moves no money and
      approving one does, irreversibly.

      Checked here rather than with a route decorator because a decorator applies to every
      caller, and gating the route locked organizers out of their own console.
    */
    if (this.access.isPlatformAdmin(user)) {
      await this.assertMayApproveAsStaff(user);
    } else {
      await this.access.assertMember(user, refund.organizationId, [Role.ORGANIZER_OWNER]);
    }
    if (refund.status !== RefundStatus.REQUESTED) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `Refund already ${refund.status}.`,
        HttpStatus.CONFLICT,
      );
    }

    if (decision === 'REJECT') {
      // Atomic claim: only one caller can transition REQUESTED → REJECTED.
      const claim = await this.prisma.refund.updateMany({
        where: { id: refundId, status: RefundStatus.REQUESTED },
        data: { status: RefundStatus.REJECTED, processedByUserId: user.id },
      });
      if (claim.count !== 1) {
        throw new AppException(
          ErrorCodes.CONFLICT,
          'Refund is already being processed.',
          HttpStatus.CONFLICT,
        );
      }
      await this.audit.record({
        actorUserId: user.id,
        organizationId: refund.organizationId,
        action: 'REFUND_REJECTED',
        entityType: 'Refund',
        entityId: refundId,
      });
      return this.prisma.refund.findUnique({ where: { id: refundId } });
    }

    /*
      A cash booking cannot be refunded online — see the same refusal in `request`. Checked
      before the claim so a request that predates that refusal stays REQUESTED and can still
      be rejected, rather than being sent to whichever provider happens to be the default.
    */
    const paidHow = await this.prisma.booking.findUnique({
      where: { id: refund.bookingId },
      select: { paymentMethod: true },
    });
    if (paidHow?.paymentMethod === 'CASH' && refund.amountMinor > 0) {
      throw new AppException(
        ErrorCodes.REFUND_NOT_ELIGIBLE,
        'This booking was paid in cash at the venue. Cash refunds are handled at the venue, not online.',
        HttpStatus.CONFLICT,
      );
    }

    // Atomic claim BEFORE any money moves: prevents concurrent double-approval
    // (and thus double provider refunds). Only the winner proceeds.
    const claim = await this.prisma.refund.updateMany({
      where: { id: refundId, status: RefundStatus.REQUESTED },
      data: { status: RefundStatus.PROCESSING, processedByUserId: user.id },
    });
    if (claim.count !== 1) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'Refund is already being processed.',
        HttpStatus.CONFLICT,
      );
    }

    const booking = await this.prisma.booking.findUnique({
      where: { id: refund.bookingId },
      include: {
        tickets: true,
        items: true,
        event: { select: { experienceType: true } },
      },
    });
    if (!booking) {
      await this.prisma.refund.update({
        where: { id: refundId },
        data: { status: RefundStatus.FAILED },
      });
      throw new AppException(ErrorCodes.NOT_FOUND, 'Booking not found.', HttpStatus.NOT_FOUND);
    }

    /*
      Every ticket this refund names must still be live BEFORE any money moves.

      The provider used to be called first and the ticket status looked at afterwards, so a
      refund whose tickets had already gone back through another refund still paid out — and
      then voided nothing. Refused here, the second payout never happens.
    */
    const stillLive = new Set(
      booking.tickets
        .filter((t) => t.status === TicketStatus.ACTIVE || t.status === TicketStatus.CHECKED_IN)
        .map((t) => t.id),
    );
    const gone = refund.ticketIds.filter((id) => !stillLive.has(id));
    if (gone.length > 0) {
      await this.prisma.refund.update({
        where: { id: refundId },
        data: { status: RefundStatus.FAILED },
      });
      await this.audit.record({
        actorUserId: user.id,
        organizationId: refund.organizationId,
        action: 'REFUND_TICKETS_NOT_LIVE',
        entityType: 'Refund',
        entityId: refundId,
        metadata: { ticketIds: gone },
      });
      throw new AppException(
        ErrorCodes.CONFLICT,
        'Some tickets on this refund have already been refunded or cancelled, so nothing was paid out.',
        HttpStatus.CONFLICT,
        { ticketIds: gone },
      );
    }

    const payment = await this.prisma.payment.findUnique({
      where: { bookingId: refund.bookingId },
    });

    /*
      Nothing was captured, so there is nothing to reverse.

      A free booking has no Payment row at all — deliberately, so it never appears in a
      settlement report that cannot balance. Cancelling one still has to do everything else a
      cancellation does: void the tickets, hand the seats back, record the refund, notify the
      customer. Only the gateway leg is absent, and asking a gateway to return zero rupees
      against a payment it never took would fail loudly for no reason.

      Narrow on purpose: this needs BOTH no payment row and a zero amount. A booking that owes
      a real refund but has lost its payment row is a fault, and quietly marking it COMPLETED
      would be the platform keeping a customer's money.
    */
    const nothingWasCaptured = !payment && refund.amountMinor === 0;

    // Provider call happens exactly once (after the claim). On failure the refund
    // is marked FAILED rather than left stuck in PROCESSING.
    let providerResult: { providerRef: string; status?: 'COMPLETED' | 'PROCESSING' | 'FAILED' };
    try {
      providerResult = nothingWasCaptured
        ? { providerRef: `free:${refund.bookingId}`, status: 'COMPLETED' }
        : await this.payments.refundPayment(
            payment?.providerRef ?? 'mock',
            refund.amountMinor,
            refund.reason,
            // Keep the refund on the gateway that captured the payment.
            payment?.provider,
            // Currency lets PayPal/Square format a partial refund.
            booking.currency,
          );
    } catch (err) {
      await this.prisma.refund
        .update({ where: { id: refundId }, data: { status: RefundStatus.FAILED } })
        .catch(() => undefined);
      throw err;
    }

    /*
      The provider's answer decides what the row says.

      A refund the gateway refused came back FAILED and was then marked COMPLETED, with the
      tickets voided — the customer told their money was on its way when it was not.

      A refund the gateway ACCEPTED but has not yet paid (Razorpay's `pending`) stays PROCESSING.
      The tickets still go back now, because the refund is committed at the provider; the row
      becomes COMPLETED when `refund.processed` arrives, or FAILED on `refund.failed`, both in
      the Razorpay webhook processor. Until then it sits in the admin queue under PROCESSING.
    */
    if (providerResult.status === 'FAILED') {
      await this.prisma.refund.update({
        where: { id: refundId },
        data: { status: RefundStatus.FAILED, providerRef: providerResult.providerRef },
      });
      await this.audit.record({
        actorUserId: user.id,
        organizationId: refund.organizationId,
        action: 'REFUND_FAILED',
        entityType: 'Refund',
        entityId: refundId,
        metadata: { amountMinor: refund.amountMinor, providerRef: providerResult.providerRef },
      });
      throw new AppException(
        ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE,
        'The payment provider refused this refund. No tickets were cancelled.',
        HttpStatus.BAD_GATEWAY,
      );
    }
    const settledStatus =
      providerResult.status === 'PROCESSING' ? RefundStatus.PROCESSING : RefundStatus.COMPLETED;

    // Only void tickets that are still live; return their stock via the
    // experience's inventory strategy (frees movie seats + decrements counters).
    // The booking's own seating, so seats go back to the map they came from and counters
    // go back to the counter — see the same call in the confirmation path.
    const strategy = this.inventory.forSeating(booking.seatBased);
    const voided = booking.tickets.filter(
      (t) =>
        refund.ticketIds.includes(t.id) &&
        (t.status === TicketStatus.ACTIVE || t.status === TicketStatus.CHECKED_IN),
    );

    await this.prisma.$transaction(async (tx) => {
      if (voided.length > 0) {
        await tx.ticket.updateMany({
          where: { id: { in: voided.map((t) => t.id) } },
          data: { status: TicketStatus.REFUNDED },
        });
        await strategy.refund(tx, {
          eventSessionId: booking.eventSessionId,
          tickets: voided.map((t) => ({ ticketTypeId: t.ticketTypeId, seatId: t.seatId })),
        });
      }

      const remainingActive = booking.tickets.filter(
        (t) =>
          !refund.ticketIds.includes(t.id) &&
          (t.status === TicketStatus.ACTIVE || t.status === TicketStatus.CHECKED_IN),
      ).length;
      const bookingStatus =
        remainingActive === 0 ? BookingStatus.REFUNDED : BookingStatus.PARTIALLY_REFUNDED;
      const paymentStatus =
        remainingActive === 0 ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED;

      await tx.booking.update({ where: { id: booking.id }, data: { status: bookingStatus } });
      await tx.payment.updateMany({
        where: { bookingId: booking.id },
        data: { status: paymentStatus },
      });
      await tx.refund.update({
        where: { id: refundId },
        data: {
          status: settledStatus,
          processedByUserId: user.id,
          providerRef: providerResult.providerRef,
        },
      });

      // The refund is reversed with a credit note, in the same transaction that completes
      // it. The original receipt is never edited — it recorded a sale that genuinely
      // happened, and rewriting it would destroy the audit trail the pair exists to provide.
      await this.receipts.issueCreditNote(tx, refundId);

      /*
        Told in the same transaction that completes the refund, for the same reason the
        credit note is issued in it: "the money went back" and "the customer knows the money
        went back" must not be able to come apart. Enqueued after the commit, a crash in
        between leaves somebody's refund invisible to them, and nothing to retry.

        The reference and currency travel with it so the notice can name the booking the way
        the customer knows it, and show the amount as money rather than minor units.

        `refundId` is what makes duplicate suppression correct here. A booking can be
        refunded in parts, and two partial refunds of the same amount are two real refunds --
        so the refund's own id, not the booking's, separates one notice from the next.
      */
      await this.notifications.sendCritical(tx, {
        type: NotificationType.REFUND_COMPLETED,
        userId: booking.userId,
        toEmail: booking.buyerEmail,
        payload: {
          bookingId: booking.id,
          refundId,
          reference: booking.reference ?? '',
          currency: booking.currency,
          amountMinor: refund.amountMinor,
        },
      });
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: refund.organizationId,
      action: settledStatus === RefundStatus.COMPLETED ? 'REFUND_COMPLETED' : 'REFUND_PROCESSING',
      entityType: 'Refund',
      entityId: refundId,
      metadata: { amountMinor: refund.amountMinor, providerRef: providerResult.providerRef },
    });
    if (settledStatus === RefundStatus.COMPLETED) this.metrics.recordRefundCompleted();
    return this.prisma.refund.findUnique({ where: { id: refundId } });
  }
}
