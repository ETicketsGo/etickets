import { HttpStatus, Injectable } from '@nestjs/common';
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
import { ACCEPTED_TRANSFERS, currentHolderUserId } from '../tickets/ticket-holder';
import type { RequestUser } from '../common/decorators';
import { MetricsService } from '../metrics/metrics.service';

/** Refund rows that hold or consume a ticket's refund allocation. */
const OPEN_REFUND_STATUSES = [
  RefundStatus.REQUESTED,
  RefundStatus.PROCESSING,
  RefundStatus.COMPLETED,
] as const;

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

  async request(user: RequestUser, input: RefundRequestInput) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: input.bookingId },
      include: {
        // The organizer's policy travels with the booking, so eligibility is decided by
        // their terms rather than by a constant in platform code.
        eventSession: { select: { startsAt: true } },
        event: { select: { refundsEnabled: true, refundCutoffHours: true } },
        // Accepted transfers travel with each ticket, so the refund can tell whose it is now.
        tickets: { include: { invites: ACCEPTED_TRANSFERS } },
        taxLines: true,
      },
    });
    if (!booking)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Booking not found.', HttpStatus.NOT_FOUND);
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
    const actingAsStaff = this.access.isPlatformAdmin(user);
    const heldByCaller = (t: (typeof booking.tickets)[number]) =>
      currentHolderUserId({ booking, invites: t.invites }) === user.id;
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

      return tx.refund.create({
        data: {
          bookingId: booking.id,
          organizationId: booking.organizationId,
          amountMinor,
          taxMinor,
          reason: input.reason,
          status: RefundStatus.REQUESTED,
          ticketIds: targetTickets.map((t) => t.id),
          requestedByUserId: user.id,
        },
      });
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: booking.organizationId,
      action: 'REFUND_REQUESTED',
      entityType: 'Refund',
      entityId: refund.id,
      metadata: { amountMinor: refund.amountMinor },
    });
    return refund;
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

  async adminList(status: RefundStatus | undefined, page: number, pageSize: number) {
    const where = status ? { status } : {};
    const [total, data] = await this.prisma.$transaction([
      this.prisma.refund.count({ where }),
      this.prisma.refund.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        // A Refund has no currency column; it is paid back in its booking's. Without it the
        // queue formatted every amount as rupees.
        include: { booking: { select: { buyerEmail: true, eventId: true, currency: true } } },
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
