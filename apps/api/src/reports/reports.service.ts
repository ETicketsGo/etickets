import { Injectable } from '@nestjs/common';
import {
  BookingStatus,
  EventStatus,
  OrganizationStatus,
  PaymentStatus,
  RefundStatus,
  Role,
  TicketStatus,
} from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import type { RequestUser } from '../common/decorators';
import { toCsv } from '../common/csv';

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
    // This report exposes gross/net revenue, fees and refunds — financial data.
    // Restrict to org owners/managers (+ platform admins, who bypass in
    // assertMember); CHECKIN_STAFF and other members must not read the money.
    await this.access.assertMember(user, event.organizationId, [
      Role.ORGANIZER_OWNER,
      Role.ORGANIZER_MANAGER,
    ]);

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
        // Ticket lines only; add-on/bundle lines (v1.3) are reported separately.
        where: { ticketTypeId: { not: null }, booking: paidWhere },
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
      where: { id: { in: salesByType.map((s) => s.ticketTypeId).filter((x): x is string => !!x) } },
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
        ticketType: (s.ticketTypeId && nameById.get(s.ticketTypeId)) || s.ticketTypeId || 'Unknown',
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

  /** CSV form of the organizer event report (summary + sales by ticket type + by day). */
  async organizerEventReportCsv(user: RequestUser, eventId: string): Promise<string | null> {
    const r = await this.organizerEventReport(user, eventId);
    if (!r) return null;
    const summary = toCsv(
      ['metric', 'value'],
      [
        ['Event', r.event.title],
        ['Gross ticket sales (minor)', r.grossTicketSalesMinor],
        ['Booking fees (minor)', r.bookingFeesMinor],
        ['Payment fees (minor)', r.paymentFeesMinor],
        ['Refunds (minor)', r.refundsMinor],
        ['Net organizer revenue (minor)', r.netOrganizerRevenueMinor],
        ['Tickets sold', r.ticketsSold],
        ['Tickets remaining', r.ticketsRemaining],
        ['Checked in', r.checkInCount],
      ],
    );
    const byType = toCsv(
      ['ticketType', 'quantity', 'grossMinor'],
      r.salesByTicketType.map((s) => [s.ticketType, s.quantity, s.grossMinor]),
    );
    const byDay = toCsv(
      ['day', 'bookings', 'grossMinor'],
      r.salesByDay.map((s) => [
        new Date(s.day).toISOString().slice(0, 10),
        s.bookings,
        s.grossMinor,
      ]),
    );
    return `Summary\r\n${summary}\r\n\r\nSales by ticket type\r\n${byType}\r\n\r\nSales by day\r\n${byDay}\r\n`;
  }

  /**
   * Commerce report for an event (v1.3 WS7): add-on revenue by type, top add-ons,
   * bundle performance, plus parking / donation / merchandise headlines. Derived
   * from confirmed-booking line items — standalone add-on lines (kind ADDON) drive
   * the add-on figures; bundle component lines (kind BUNDLE) drive bundle figures.
   */
  async organizerCommerceReport(user: RequestUser, eventId: string) {
    const event = await this.prisma.event.findUnique({ where: { id: eventId } });
    if (!event) return null;
    await this.access.assertMember(user, event.organizationId, [
      Role.ORGANIZER_OWNER,
      Role.ORGANIZER_MANAGER,
    ]);

    const paidBooking = { eventId, confirmedAt: { not: null } };
    const [addOnLines, bundleLines] = await Promise.all([
      this.prisma.bookingItem.findMany({
        where: { kind: 'ADDON', booking: paidBooking },
        select: {
          quantity: true,
          lineTotalMinor: true,
          addOnId: true,
          addOn: { select: { name: true, type: true } },
        },
      }),
      this.prisma.bookingItem.findMany({
        where: { kind: 'BUNDLE', booking: paidBooking },
        select: {
          quantity: true,
          lineTotalMinor: true,
          bundleId: true,
          bundle: { select: { name: true, type: true } },
        },
      }),
    ]);

    const byType = new Map<string, { quantity: number; grossMinor: number }>();
    const byAddOn = new Map<
      string,
      { name: string; type: string; quantity: number; grossMinor: number }
    >();
    for (const l of addOnLines) {
      const type = l.addOn?.type ?? 'UNKNOWN';
      const t = byType.get(type) ?? { quantity: 0, grossMinor: 0 };
      t.quantity += l.quantity;
      t.grossMinor += l.lineTotalMinor;
      byType.set(type, t);
      if (l.addOnId) {
        const a = byAddOn.get(l.addOnId) ?? {
          name: l.addOn?.name ?? 'Add-on',
          type,
          quantity: 0,
          grossMinor: 0,
        };
        a.quantity += l.quantity;
        a.grossMinor += l.lineTotalMinor;
        byAddOn.set(l.addOnId, a);
      }
    }

    const byBundle = new Map<
      string,
      { name: string; type: string; quantity: number; grossMinor: number }
    >();
    for (const l of bundleLines) {
      if (!l.bundleId) continue;
      const b = byBundle.get(l.bundleId) ?? {
        name: l.bundle?.name ?? 'Bundle',
        type: l.bundle?.type ?? 'UNKNOWN',
        quantity: 0,
        grossMinor: 0,
      };
      b.quantity += l.quantity;
      b.grossMinor += l.lineTotalMinor;
      byBundle.set(l.bundleId, b);
    }

    const typeTotal = (type: string) => byType.get(type)?.grossMinor ?? 0;
    const addOnRevenueMinor = addOnLines.reduce((s, l) => s + l.lineTotalMinor, 0);
    const bundleRevenueMinor = bundleLines.reduce((s, l) => s + l.lineTotalMinor, 0);

    return {
      event: { id: event.id, title: event.title },
      addOnRevenueMinor,
      bundleRevenueMinor,
      donationTotalMinor: typeTotal('DONATION'),
      parkingRevenueMinor: typeTotal('PARKING'),
      merchandiseRevenueMinor: typeTotal('MERCHANDISE'),
      foodBeverageRevenueMinor: typeTotal('FOOD_BEVERAGE'),
      byType: [...byType.entries()]
        .map(([type, v]) => ({ type, ...v }))
        .sort((a, b) => b.grossMinor - a.grossMinor),
      topAddOns: [...byAddOn.values()].sort((a, b) => b.grossMinor - a.grossMinor).slice(0, 20),
      bundles: [...byBundle.values()].sort((a, b) => b.grossMinor - a.grossMinor),
    };
  }

  /** CSV form of the commerce report. */
  async organizerCommerceReportCsv(user: RequestUser, eventId: string): Promise<string | null> {
    const r = await this.organizerCommerceReport(user, eventId);
    if (!r) return null;
    const summary = toCsv(
      ['metric', 'value'],
      [
        ['Event', r.event.title],
        ['Add-on revenue (minor)', r.addOnRevenueMinor],
        ['Bundle revenue (minor)', r.bundleRevenueMinor],
        ['Donations (minor)', r.donationTotalMinor],
        ['Parking (minor)', r.parkingRevenueMinor],
        ['Merchandise (minor)', r.merchandiseRevenueMinor],
        ['Food & beverage (minor)', r.foodBeverageRevenueMinor],
      ],
    );
    const byType = toCsv(
      ['addOnType', 'quantity', 'grossMinor'],
      r.byType.map((t) => [t.type, t.quantity, t.grossMinor]),
    );
    const addOns = toCsv(
      ['addOn', 'type', 'quantity', 'grossMinor'],
      r.topAddOns.map((a) => [a.name, a.type, a.quantity, a.grossMinor]),
    );
    const bundles = toCsv(
      ['bundle', 'type', 'unitsSold', 'grossMinor'],
      r.bundles.map((b) => [b.name, b.type, b.quantity, b.grossMinor]),
    );
    return `Summary\r\n${summary}\r\n\r\nAdd-on revenue by type\r\n${byType}\r\n\r\nTop add-ons\r\n${addOns}\r\n\r\nBundle performance\r\n${bundles}\r\n`;
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
