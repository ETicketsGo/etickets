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

  /**
   * The currency an event sells in, for its organizer reports.
   *
   * Report totals are bare minor units; without a currency the console formatted them as
   * rupees, so a USD event's sales read "₹". Ticket types are created in the venue's
   * currency, so the first one names the event's. An event with none has sold nothing, and
   * its zeros read the same in any currency.
   */
  private async eventCurrency(eventId: string): Promise<string> {
    const first = await this.prisma.ticketType.findFirst({
      where: { eventSession: { eventId } },
      orderBy: { createdAt: 'asc' },
      select: { currency: true },
    });
    return first?.currency ?? 'INR';
  }

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
    const currency = await this.eventCurrency(eventId);

    return {
      event: { id: event.id, title: event.title, status: event.status },
      currency,
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
    // Aggregate in SQL grouped by add-on / bundle (cardinality = distinct products,
    // bounded), not per line item, so a huge event never loads every row into memory.
    const [addOnGroups, bundleGroups] = await Promise.all([
      this.prisma.bookingItem.groupBy({
        by: ['addOnId'],
        where: { kind: 'ADDON', addOnId: { not: null }, booking: paidBooking },
        _sum: { quantity: true, lineTotalMinor: true },
      }),
      this.prisma.bookingItem.groupBy({
        by: ['bundleId'],
        where: { kind: 'BUNDLE', bundleId: { not: null }, booking: paidBooking },
        _sum: { quantity: true, lineTotalMinor: true },
      }),
    ]);

    const addOnIds = addOnGroups.map((g) => g.addOnId).filter((x): x is string => !!x);
    const bundleIds = bundleGroups.map((g) => g.bundleId).filter((x): x is string => !!x);
    const [addOns, bundles] = await Promise.all([
      addOnIds.length
        ? this.prisma.addOn.findMany({
            where: { id: { in: addOnIds } },
            select: { id: true, name: true, type: true },
          })
        : Promise.resolve([]),
      bundleIds.length
        ? this.prisma.bundle.findMany({
            where: { id: { in: bundleIds } },
            select: { id: true, name: true, type: true },
          })
        : Promise.resolve([]),
    ]);
    const addOnMeta = new Map(addOns.map((a) => [a.id, a]));
    const bundleMeta = new Map(bundles.map((b) => [b.id, b]));

    const byType = new Map<string, { quantity: number; grossMinor: number }>();
    const topAddOns: { name: string; type: string; quantity: number; grossMinor: number }[] = [];
    let addOnRevenueMinor = 0;
    for (const g of addOnGroups) {
      const meta = g.addOnId ? addOnMeta.get(g.addOnId) : undefined;
      const type = meta?.type ?? 'UNKNOWN';
      const quantity = g._sum.quantity ?? 0;
      const grossMinor = g._sum.lineTotalMinor ?? 0;
      addOnRevenueMinor += grossMinor;
      const t = byType.get(type) ?? { quantity: 0, grossMinor: 0 };
      t.quantity += quantity;
      t.grossMinor += grossMinor;
      byType.set(type, t);
      topAddOns.push({ name: meta?.name ?? 'Add-on', type, quantity, grossMinor });
    }

    const bundleRows: { name: string; type: string; quantity: number; grossMinor: number }[] = [];
    let bundleRevenueMinor = 0;
    for (const g of bundleGroups) {
      const meta = g.bundleId ? bundleMeta.get(g.bundleId) : undefined;
      const quantity = g._sum.quantity ?? 0;
      const grossMinor = g._sum.lineTotalMinor ?? 0;
      bundleRevenueMinor += grossMinor;
      bundleRows.push({
        name: meta?.name ?? 'Bundle',
        type: meta?.type ?? 'UNKNOWN',
        quantity,
        grossMinor,
      });
    }

    const typeTotal = (type: string) => byType.get(type)?.grossMinor ?? 0;
    const currency = await this.eventCurrency(eventId);

    return {
      event: { id: event.id, title: event.title },
      currency,
      addOnRevenueMinor,
      bundleRevenueMinor,
      donationTotalMinor: typeTotal('DONATION'),
      parkingRevenueMinor: typeTotal('PARKING'),
      merchandiseRevenueMinor: typeTotal('MERCHANDISE'),
      foodBeverageRevenueMinor: typeTotal('FOOD_BEVERAGE'),
      byType: [...byType.entries()]
        .map(([type, v]) => ({ type, ...v }))
        .sort((a, b) => b.grossMinor - a.grossMinor),
      topAddOns: topAddOns.sort((a, b) => b.grossMinor - a.grossMinor).slice(0, 20),
      bundles: bundleRows.sort((a, b) => b.grossMinor - a.grossMinor),
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
      paidByCurrency,
      refundsByCurrency,
      totalBookings,
      activeOrganizers,
      publishedEvents,
      paymentFailures,
      upcomingPayouts,
    ] = await Promise.all([
      /*
        ── MONEY IS PER CURRENCY ──────────────────────────────────────────────────────
        Reported from QA: the overview showed "Gross merchandise value ₹11,389.60" — rupees,
        dollars and Canadian dollars added together and printed with a rupee sign. A sum
        across currencies is not an amount of anything. Every money figure is grouped by the
        currency the booking was sold in, and the page shows one market at a time.
      */
      this.prisma.booking.groupBy({
        by: ['currency'],
        where: { confirmedAt: { not: null } },
        _sum: { totalMinor: true, bookingFeeMinor: true, paymentFeeMinor: true },
        _count: { _all: true },
      }),
      // A refund carries no currency of its own; it is in the currency of the booking it returns.
      this.prisma.$queryRaw<{ currency: string; amountMinor: bigint | number | null }[]>`
        SELECT b."currency" AS currency, COALESCE(SUM(r."amountMinor"), 0) AS "amountMinor"
        FROM "Refund" r
        JOIN "Booking" b ON b."id" = r."bookingId"
        WHERE r."status" = 'COMPLETED'
        GROUP BY b."currency"`,
      this.prisma.booking.count(),
      this.prisma.organization.count({ where: { status: OrganizationStatus.APPROVED } }),
      this.prisma.event.count({ where: { status: EventStatus.PUBLISHED } }),
      this.prisma.payment.count({ where: { status: PaymentStatus.FAILED } }),
      this.prisma.payout.count({ where: { status: { in: ['PENDING', 'SCHEDULED'] } } }),
    ]);

    const refunds = new Map(
      refundsByCurrency.map((row) => [row.currency.toUpperCase(), Number(row.amountMinor ?? 0)]),
    );
    const currencies = new Set([
      ...paidByCurrency.map((row) => row.currency.toUpperCase()),
      ...refunds.keys(),
    ]);
    const money = [...currencies]
      .map((currency) => {
        const paid = paidByCurrency.filter((row) => row.currency.toUpperCase() === currency);
        const sum = (pick: (row: (typeof paidByCurrency)[number]) => number | null | undefined) =>
          paid.reduce((total, row) => total + (pick(row) ?? 0), 0);
        return {
          currency,
          gmvMinor: sum((row) => row._sum.totalMinor),
          platformRevenueMinor: sum(
            (row) => (row._sum.bookingFeeMinor ?? 0) + (row._sum.paymentFeeMinor ?? 0),
          ),
          refundVolumeMinor: refunds.get(currency) ?? 0,
          paidBookings: sum((row) => row._count._all),
        };
      })
      // The biggest market first, so the page opens on the figures that matter most.
      .sort((a, b) => b.gmvMinor - a.gmvMinor || a.currency.localeCompare(b.currency));

    return {
      /** One entry per currency sold in. The only money a screen should show. */
      money,
      /**
       * Sums ACROSS currencies — kept so an older client does not break, and never to be shown:
       * they add rupees to dollars. Use `money`.
       */
      gmvMinor: money.reduce((total, row) => total + row.gmvMinor, 0),
      platformRevenueMinor: money.reduce((total, row) => total + row.platformRevenueMinor, 0),
      totalBookings,
      refundVolumeMinor: money.reduce((total, row) => total + row.refundVolumeMinor, 0),
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
