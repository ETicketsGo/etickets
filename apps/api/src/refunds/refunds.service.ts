import { HttpStatus, Injectable } from '@nestjs/common';
import {
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
  ) {}

  async request(user: RequestUser, input: RefundRequestInput) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: input.bookingId },
      include: { eventSession: { select: { startsAt: true } }, tickets: true },
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
    const amountMinor = targetTickets.reduce(
      (s, t) => s + (priceByType.get(t.ticketTypeId) ?? 0),
      0,
    );

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

  /** Admin (or organizer owner) decides a refund; on approval, money + tickets settle. */
  async process(user: RequestUser, refundId: string, decision: 'APPROVE' | 'REJECT') {
    const refund = await this.prisma.refund.findUnique({ where: { id: refundId } });
    if (!refund)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Refund not found.', HttpStatus.NOT_FOUND);
    if (!this.access.isPlatformAdmin(user)) {
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
    });

    await this.notifications.send({
      type: NotificationType.REFUND_COMPLETED,
      userId: booking.userId,
      toEmail: booking.buyerEmail,
      payload: { bookingId: booking.id, amountMinor: refund.amountMinor },
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
