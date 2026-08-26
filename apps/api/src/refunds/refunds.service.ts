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
        tickets: true,
        taxLines: true,
      },
    });
    if (!booking)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Booking not found.', HttpStatus.NOT_FOUND);
    if (booking.userId !== user.id && !this.access.isPlatformAdmin(user)) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'You cannot refund this booking.',
        HttpStatus.FORBIDDEN,
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

    // Tickets already covered by an open (requested/processing/completed) refund
    // must not be refunded again.
    const priorRefunds = await this.prisma.refund.findMany({
      where: { bookingId: booking.id, status: { in: [...OPEN_REFUND_STATUSES] } },
    });
    const alreadyCovered = new Set(priorRefunds.flatMap((r) => r.ticketIds));

    // Only ACTIVE/CHECKED_IN tickets are refundable — apply the status filter even
    // when the client supplies ticketIds (so already-refunded ids can't sneak in).
    const refundable = (
      input.ticketIds?.length
        ? booking.tickets.filter((t) => input.ticketIds!.includes(t.id))
        : booking.tickets
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
    const items = await this.prisma.bookingItem.findMany({ where: { bookingId: booking.id } });
    const priceByType = new Map(items.map((i) => [i.ticketTypeId, i.unitPriceMinor]));
    const ticketsMinor = targetTickets.reduce(
      (s, t) => s + (priceByType.get(t.ticketTypeId) ?? 0),
      0,
    );

    /*
      Tax charged on the tickets being returned goes back with them.

      Booking and payment fees do NOT — that is the platform's long-standing policy and this
      change does not touch it. Tax is different in kind: it was collected because a taxable
      supply happened, and undoing the supply undoes the reason for collecting it. Keeping it
      would mean the customer paid tax on a ticket they no longer hold.

      Each rate is re-applied to the amount actually being returned rather than apportioned
      out of the original total, so the arithmetic on the credit note is reproducible from the
      rate and the base exactly as it was on the invoice. Nothing here decides WHAT rate
      applies — that is TaxRule configuration, and with none active this whole block is zero.
    */
    const taxMinor = (booking.taxLines ?? []).reduce(
      (sum, line) =>
        sum + Math.round((Math.min(ticketsMinor, line.baseMinor) * line.rateBasisPoints) / 10_000),
      0,
    );
    const amountMinor = ticketsMinor + taxMinor;

    // Never let cumulative refunds exceed what was paid.
    const priorAmount = priorRefunds.reduce((s, r) => s + r.amountMinor, 0);
    if (priorAmount + amountMinor > booking.totalMinor) {
      throw new AppException(
        ErrorCodes.REFUND_NOT_ELIGIBLE,
        'Refund amount exceeds the remaining refundable balance.',
        HttpStatus.CONFLICT,
      );
    }

    const refund = await this.prisma.refund.create({
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
    await this.audit.record({
      actorUserId: user.id,
      organizationId: booking.organizationId,
      action: 'REFUND_REQUESTED',
      entityType: 'Refund',
      entityId: refund.id,
      metadata: { amountMinor },
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
        include: { booking: { select: { buyerEmail: true, eventId: true } } },
      }),
    ]);
    return { data, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
  }

  /**
   * One organization's refunds.
   *
   * `adminList` above is deliberately unscoped — it is the platform's queue. An organizer
   * reaching for it would see every seller's refunds, so this is a separate query with the
   * tenant filter applied in the WHERE clause rather than after the fact. Membership is
   * asserted first, so a caller cannot read another organization's book by passing its id.
   */
  async listForOrganization(
    user: RequestUser,
    organizationId: string,
    opts: { status?: RefundStatus; page?: number; pageSize?: number } = {},
  ) {
    await this.access.assertMember(user, organizationId);
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

    const payment = await this.prisma.payment.findUnique({
      where: { bookingId: refund.bookingId },
    });

    // Provider call happens exactly once (after the claim). On failure the refund
    // is marked FAILED rather than left stuck in PROCESSING.
    let providerResult: { providerRef: string };
    try {
      providerResult = await this.payments.refundPayment(
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

    // Only void tickets that are still live; return their stock via the
    // experience's inventory strategy (frees movie seats + decrements counters).
    const strategy = this.inventory.forExperienceType(booking.event.experienceType);
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
          status: RefundStatus.COMPLETED,
          processedByUserId: user.id,
          providerRef: providerResult.providerRef,
        },
      });

      // The refund is reversed with a credit note, in the same transaction that completes
      // it. The original receipt is never edited — it recorded a sale that genuinely
      // happened, and rewriting it would destroy the audit trail the pair exists to provide.
      await this.receipts.issueCreditNote(tx, refundId);
    });

    await this.notifications.send({
      type: NotificationType.REFUND_COMPLETED,
      userId: booking.userId,
      toEmail: booking.buyerEmail,
      // The reference and currency travel with it so the notice can name the booking the way
      // the customer knows it, and show the amount as money rather than minor units.
      payload: {
        bookingId: booking.id,
        reference: booking.reference ?? '',
        currency: booking.currency,
        amountMinor: refund.amountMinor,
      },
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: refund.organizationId,
      action: 'REFUND_COMPLETED',
      entityType: 'Refund',
      entityId: refundId,
      metadata: { amountMinor: refund.amountMinor, providerRef: providerResult.providerRef },
    });
    this.metrics.recordRefundCompleted();
    return this.prisma.refund.findUnique({ where: { id: refundId } });
  }
}
