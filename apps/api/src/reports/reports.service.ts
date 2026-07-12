import { Injectable } from '@nestjs/common';
import {
  BookingStatus,
  EventStatus,
  OrganizationStatus,
  PaymentStatus,
  RefundStatus,
  TicketStatus,
} from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import type { RequestUser } from '../common/decorators';

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
  ) {}

  /** Organizer report for a single event (section 18). */
  async organizerEventReport(user: RequestUser, eventId: string) {
    const event = await this.prisma.event.findUnique({ where: { id: eventId } });
    if (!event) return null;
    await this.access.assertMember(user, event.organizationId);

    const paidWhere = { eventId, confirmedAt: { not: null } };
    const money = await this.prisma.booking.aggregate({
      where: paidWhere,
      _sum: {
        subtotalMinor: true,
        bookingFeeMinor: true,
        paymentFeeMinor: true,
        organizerFeeMinor: true,
      },
    });
    const refundAgg = await this.prisma.refund.aggregate({
      where: { booking: { eventId }, status: RefundStatus.COMPLETED },
      _sum: { amountMinor: true },
    });

    const [ticketsSold, checkInCount, inventory, salesByType, salesByDayRaw] = await Promise.all([
      this.prisma.ticket.count({
        where: {
          eventSession: { eventId },
          status: { in: [TicketStatus.ACTIVE, TicketStatus.CHECKED_IN] },
        },
      }),
      this.prisma.ticket.count({
        where: { eventSession: { eventId }, status: TicketStatus.CHECKED_IN },
      }),
      this.prisma.ticketInventory.aggregate({
        where: { ticketType: { eventSession: { eventId } } },
        _sum: { quantityTotal: true, quantitySold: true },
      }),
      this.prisma.bookingItem.groupBy({
        by: ['ticketTypeId'],
        where: { booking: paidWhere },
        _sum: { quantity: true, lineTotalMinor: true },
      }),
      this.prisma.$queryRaw<{ day: Date; count: bigint; gross: bigint }[]>`
        SELECT date_trunc('day', "confirmedAt") AS day, COUNT(*)::bigint AS count, SUM("subtotalMinor")::bigint AS gross
        FROM "Booking"
        WHERE "eventId" = ${eventId} AND "confirmedAt" IS NOT NULL
        GROUP BY 1 ORDER BY 1 ASC
      `,
    ]);

    const typeNames = await this.prisma.ticketType.findMany({
      where: { id: { in: salesByType.map((s) => s.ticketTypeId) } },
      select: { id: true, name: true },
    });
    const nameById = new Map(typeNames.map((t) => [t.id, t.name]));

    const gross = money._sum.subtotalMinor ?? 0;
    const bookingFees = money._sum.bookingFeeMinor ?? 0;
    const paymentFees = money._sum.paymentFeeMinor ?? 0;
    const organizerFees = money._sum.organizerFeeMinor ?? 0;
    const refunds = refundAgg._sum.amountMinor ?? 0;
    const totalStock = inventory._sum.quantityTotal ?? 0;
    const sold = inventory._sum.quantitySold ?? 0;

    return {
      event: { id: event.id, title: event.title, status: event.status },
      grossTicketSalesMinor: gross,
      bookingFeesMinor: bookingFees,
      paymentFeesMinor: paymentFees,
      refundsMinor: refunds,
      netOrganizerRevenueMinor: gross - organizerFees - refunds,
      ticketsSold,
      ticketsRemaining: Math.max(0, totalStock - sold),
      checkInCount,
      salesByTicketType: salesByType.map((s) => ({
        ticketType: nameById.get(s.ticketTypeId) ?? s.ticketTypeId,
        quantity: s._sum.quantity ?? 0,
        grossMinor: s._sum.lineTotalMinor ?? 0,
      })),
      salesByDay: salesByDayRaw.map((r) => ({
        day: r.day,
        bookings: Number(r.count),
        grossMinor: Number(r.gross),
      })),
    };
  }

  /** Platform-wide admin dashboard (section 18). */
  async adminDashboard() {
    const [
      gmvAgg,
      feeAgg,
      totalBookings,
      refundAgg,
      activeOrganizers,
      publishedEvents,
      paymentFailures,
      upcomingPayouts,
    ] = await Promise.all([
      this.prisma.booking.aggregate({
        where: { confirmedAt: { not: null } },
        _sum: { totalMinor: true },
      }),
      this.prisma.booking.aggregate({
        where: { confirmedAt: { not: null } },
        _sum: { bookingFeeMinor: true, paymentFeeMinor: true },
      }),
      this.prisma.booking.count(),
      this.prisma.refund.aggregate({
        where: { status: RefundStatus.COMPLETED },
        _sum: { amountMinor: true },
      }),
      this.prisma.organization.count({ where: { status: OrganizationStatus.APPROVED } }),
      this.prisma.event.count({ where: { status: EventStatus.PUBLISHED } }),
      this.prisma.payment.count({ where: { status: PaymentStatus.FAILED } }),
      this.prisma.payout.count({ where: { status: { in: ['PENDING', 'SCHEDULED'] } } }),
    ]);

    return {
      gmvMinor: gmvAgg._sum.totalMinor ?? 0,
      platformRevenueMinor: (feeAgg._sum.bookingFeeMinor ?? 0) + (feeAgg._sum.paymentFeeMinor ?? 0),
      totalBookings,
      refundVolumeMinor: refundAgg._sum.amountMinor ?? 0,
      activeOrganizers,
      publishedEvents,
      paymentFailures,
      upcomingPayouts,
      confirmedBookings: await this.prisma.booking.count({
        where: { status: BookingStatus.CONFIRMED },
      }),
      pendingOrganizers: await this.prisma.organization.count({
        where: { status: OrganizationStatus.PENDING },
      }),
      pendingEvents: await this.prisma.event.count({ where: { status: EventStatus.UNDER_REVIEW } }),
    };
  }
}
