import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  BookingStatus,
  EventStatus,
  ExperienceType,
  Role,
  TicketStatus,
  RefundStatus,
} from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { ReportsService } from '../reports/reports.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';

/** Tickets that count as "issued" (sold): live + already scanned in. */
const ISSUED_TICKET_STATUSES = [TicketStatus.ACTIVE, TicketStatus.CHECKED_IN];

export interface RevenueMetrics {
  grossMinor: number;
  bookingFeesMinor: number;
  paymentFeesMinor: number;
  organizerFeesMinor: number;
  discountMinor: number;
  netMinor: number;
  confirmedBookings: number;
}
export interface RefundMetrics {
  count: number;
  amountMinor: number;
}
export interface AttendanceMetrics {
  issued: number;
  checkedIn: number;
  checkInRate: number;
}
export interface ConversionMetrics {
  total: number;
  confirmed: number;
  rate: number;
}
export interface RepeatCustomerMetrics {
  totalCustomers: number;
  repeatCustomers: number;
  rate: number;
}

export interface OrganizerAnalytics {
  organizationId: string;
  attendance: AttendanceMetrics;
  conversion: ConversionMetrics;
  repeatVisitors: RepeatCustomerMetrics;
  topTicketType: { name: string; quantity: number } | null;
  /** Capacity utilization across all of the org's ticket types. Non-financial. */
  capacity: { sold: number; capacity: number; utilization: number };
  /** Present only for OWNER/MANAGER + platform admins. */
  revenue?: RevenueMetrics;
  refunds?: RefundMetrics & { refundRate: number };
  coupons?: { redemptions: number; discountMinor: number };
  topEvents?: { eventId: string; title: string; grossMinor: number; bookings: number }[];
}

/**
 * Read-only analytics building blocks. Every metric is one grouped/aggregate
 * query; the same private helpers are composed by each dashboard so no query is
 * duplicated. Nothing here mutates booking / payment / inventory state.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    private readonly reports: ReportsService,
  ) {}

  // ───────────────────────── Reusable metric blocks ─────────────────────────

  /**
   * Confirmed-booking money in one aggregate. `where` scopes org / event / venue.
   * Public so business-operations reports can reuse it (a date range is carried in
   * an `AND` clause, since this helper pins `confirmedAt: { not: null }`).
   */
  async revenue(where: Prisma.BookingWhereInput): Promise<RevenueMetrics> {
    const agg = await this.prisma.booking.aggregate({
      where: { ...where, confirmedAt: { not: null } },
      _sum: {
        subtotalMinor: true,
        bookingFeeMinor: true,
        paymentFeeMinor: true,
        organizerFeeMinor: true,
        discountMinor: true,
      },
      _count: true,
    });
    const grossMinor = agg._sum.subtotalMinor ?? 0;
    const organizerFeesMinor = agg._sum.organizerFeeMinor ?? 0;
    return {
      grossMinor,
      bookingFeesMinor: agg._sum.bookingFeeMinor ?? 0,
      paymentFeesMinor: agg._sum.paymentFeeMinor ?? 0,
      organizerFeesMinor,
      discountMinor: agg._sum.discountMinor ?? 0,
      // Net to the organizer mirrors payouts/reports: gross − organizer fee − refunds.
      // Refunds are subtracted by callers that also load refund figures.
      netMinor: grossMinor - organizerFeesMinor,
      confirmedBookings: agg._count,
    };
  }

  /** Completed-refund count + amount in one aggregate. Public for report reuse. */
  async refundStats(where: Prisma.RefundWhereInput): Promise<RefundMetrics> {
    const agg = await this.prisma.refund.aggregate({
      where: { ...where, status: RefundStatus.COMPLETED },
      _sum: { amountMinor: true },
      _count: true,
    });
    return { count: agg._count, amountMinor: agg._sum.amountMinor ?? 0 };
  }

  /** Ticket issued-vs-checked-in from a single status groupBy. */
  private async attendance(where: Prisma.TicketWhereInput): Promise<AttendanceMetrics> {
    const groups = await this.prisma.ticket.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    });
    let issued = 0;
    let checkedIn = 0;
    for (const g of groups) {
      if ((ISSUED_TICKET_STATUSES as string[]).includes(g.status)) issued += g._count._all;
      if (g.status === TicketStatus.CHECKED_IN) checkedIn += g._count._all;
    }
    return {
      issued,
      checkedIn,
      checkInRate: issued > 0 ? Math.round((checkedIn / issued) * 100) : 0,
    };
  }

  /**
   * Conversion = converted / all bookings (incl. expired & cancelled), from one
   * status groupBy. "Converted" = any booking that reached a successful payment,
   * i.e. every post-confirmation status (a later refund/dispute doesn't undo the
   * fact that it converted). Non-converted = PENDING_PAYMENT / EXPIRED / CANCELLED.
   */
  private async conversion(where: Prisma.BookingWhereInput): Promise<ConversionMetrics> {
    const CONVERTED: string[] = [
      BookingStatus.CONFIRMED,
      BookingStatus.PARTIALLY_REFUNDED,
      BookingStatus.REFUNDED,
      BookingStatus.DISPUTED,
    ];
    const groups = await this.prisma.booking.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    });
    let total = 0;
    let confirmed = 0;
    for (const g of groups) {
      total += g._count._all;
      if (CONVERTED.includes(g.status)) confirmed += g._count._all;
    }
    return { total, confirmed, rate: total > 0 ? Math.round((confirmed / total) * 100) : 0 };
  }

  /**
   * Repeat-customer stats from a single userId groupBy over confirmed bookings.
   * One grouped query returns one row per customer; we fold it in memory (no
   * per-user query). `total` = distinct customers, `repeat` = those with >1.
   */
  async repeatCustomers(where: Prisma.BookingWhereInput): Promise<RepeatCustomerMetrics> {
    const groups = await this.prisma.booking.groupBy({
      by: ['userId'],
      where: { ...where, confirmedAt: { not: null }, userId: { not: null } },
      _count: { _all: true },
    });
    const totalCustomers = groups.length;
    const repeatCustomers = groups.filter((g) => g._count._all > 1).length;
    return {
      totalCustomers,
      repeatCustomers,
      rate: totalCustomers > 0 ? Math.round((repeatCustomers / totalCustomers) * 100) : 0,
    };
  }

  /**
   * Best-selling ticket type across the org's confirmed bookings. One grouped
   * query (ranked in SQL, take 1) + one name lookup — no per-event fan-out.
   */
  private async topTicketType(
    organizationId: string,
  ): Promise<{ name: string; quantity: number } | null> {
    const grouped = await this.prisma.bookingItem.groupBy({
      by: ['ticketTypeId'],
      // Ticket lines only — add-on lines (v1.3) have a null ticketTypeId.
      where: {
        ticketTypeId: { not: null },
        booking: { organizationId, confirmedAt: { not: null } },
      },
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: 1,
    });
    if (grouped.length === 0 || !grouped[0].ticketTypeId) return null;
    const top = grouped[0];
    const ticketTypeId = top.ticketTypeId as string;
    const ticketType = await this.prisma.ticketType.findUnique({
      where: { id: ticketTypeId },
      select: { name: true },
    });
    return { name: ticketType?.name ?? ticketTypeId, quantity: top._sum.quantity ?? 0 };
  }

  /** Confirmed bookings that redeemed a coupon (one count). */
  private couponRedemptions(where: Prisma.BookingWhereInput): Promise<number> {
    return this.prisma.booking.count({
      where: { ...where, confirmedAt: { not: null }, couponId: { not: null } },
    });
  }

  /** True when the caller may see money (platform admin, or org OWNER/MANAGER). */
  private async canViewFinancials(user: RequestUser, organizationId: string): Promise<boolean> {
    if (this.access.isPlatformAdmin(user)) return true;
    const membership = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: user.id } },
      select: { role: true, status: true },
    });
    return (
      !!membership &&
      membership.status === 'ACTIVE' &&
      (membership.role === Role.ORGANIZER_OWNER || membership.role === Role.ORGANIZER_MANAGER)
    );
  }

  // ─────────────────────────── 1. Organizer ───────────────────────────

  /**
   * Whole-organization organizer dashboard in ONE round of aggregate queries
   * (no per-event fan-out). Financial blocks are omitted for members who are
   * not OWNER/MANAGER (or a platform admin).
   */
  async organizer(user: RequestUser, organizationId: string): Promise<OrganizerAnalytics> {
    await this.access.assertMember(user, organizationId);
    const showFinancials = await this.canViewFinancials(user, organizationId);

    const [
      attendance,
      conversion,
      repeatVisitors,
      topTicketType,
      inventory,
      revenue,
      refunds,
      couponRedemptions,
      topEvents,
    ] = await Promise.all([
      this.attendance({
        organizationId,
        status: { in: ISSUED_TICKET_STATUSES },
      }),
      this.conversion({ organizationId }),
      this.repeatCustomers({ organizationId }),
      this.topTicketType(organizationId),
      // Capacity across all of the org's ticket types (nested relation filter).
      this.prisma.ticketInventory.aggregate({
        where: { ticketType: { eventSession: { event: { organizationId } } } },
        _sum: { quantityTotal: true, quantitySold: true },
      }),
      showFinancials ? this.revenue({ organizationId }) : Promise.resolve(null),
      showFinancials ? this.refundStats({ organizationId }) : Promise.resolve(null),
      showFinancials ? this.couponRedemptions({ organizationId }) : Promise.resolve(0),
      showFinancials ? this.topEvents(organizationId) : Promise.resolve(null),
    ]);

    const capacity = inventory._sum.quantityTotal ?? 0;
    const sold = inventory._sum.quantitySold ?? 0;
    const result: OrganizerAnalytics = {
      organizationId,
      attendance,
      conversion,
      repeatVisitors,
      topTicketType,
      capacity: {
        sold,
        capacity,
        utilization: capacity > 0 ? Math.round((sold / capacity) * 100) : 0,
      },
    };

    if (showFinancials && revenue && refunds) {
      const refundRate =
        revenue.grossMinor > 0 ? Math.round((refunds.amountMinor / revenue.grossMinor) * 100) : 0;
      result.revenue = { ...revenue, netMinor: revenue.netMinor - refunds.amountMinor };
      result.refunds = { ...refunds, refundRate };
      result.coupons = { redemptions: couponRedemptions, discountMinor: revenue.discountMinor };
      result.topEvents = topEvents ?? [];
    }
    return result;
  }

  /** Top events by gross confirmed sales for an organization (financials only). */
  private async topEvents(organizationId: string) {
    const groups = await this.prisma.booking.groupBy({
      by: ['eventId'],
      where: { organizationId, confirmedAt: { not: null } },
      _sum: { subtotalMinor: true },
      _count: { _all: true },
      orderBy: { _sum: { subtotalMinor: 'desc' } },
      take: 5,
    });
    const events = await this.prisma.event.findMany({
      where: { id: { in: groups.map((g) => g.eventId) } },
      select: { id: true, title: true },
    });
    const titles = new Map(events.map((e) => [e.id, e.title]));
    return groups.map((g) => ({
      eventId: g.eventId,
      title: titles.get(g.eventId) ?? 'Untitled',
      grossMinor: g._sum.subtotalMinor ?? 0,
      bookings: g._count._all,
    }));
  }

  // ─────────────────────────── 2. Venue ───────────────────────────

  async venue(user: RequestUser, venueId: string) {
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!venue)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Venue not found.', HttpStatus.NOT_FOUND);
    await this.access.assertMember(user, venue.organizationId);

    const [eventCount, sessionCount, revenue, seatOcc, gaOcc] = await Promise.all([
      this.prisma.event.count({ where: { venueId } }),
      this.prisma.eventSession.count({ where: { event: { venueId } } }),
      this.revenue({ event: { venueId } }),
      // Movie (seat-based) occupancy from ShowSeat: one status groupBy.
      this.prisma.showSeat.groupBy({
        by: ['status'],
        where: { eventSession: { event: { venueId } } },
        _count: { _all: true },
      }),
      // Event (general-admission) occupancy from TicketInventory: one aggregate.
      this.prisma.ticketInventory.aggregate({
        where: { ticketType: { eventSession: { event: { venueId } } } },
        _sum: { quantityTotal: true, quantitySold: true },
      }),
    ]);

    let seatsSold = 0;
    let seatsTotal = 0;
    for (const g of seatOcc) {
      seatsTotal += g._count._all;
      if (g.status === 'SOLD') seatsSold += g._count._all;
    }
    const gaTotal = gaOcc._sum.quantityTotal ?? 0;
    const gaSold = gaOcc._sum.quantitySold ?? 0;

    const capacity = seatsTotal + gaTotal;
    const sold = seatsSold + gaSold;
    return {
      venue: { id: venue.id, name: venue.name, city: venue.city },
      utilization: { events: eventCount, sessions: sessionCount },
      occupancy: {
        soldSeats: seatsSold,
        totalSeats: seatsTotal,
        soldGeneralAdmission: gaSold,
        totalGeneralAdmission: gaTotal,
        sold,
        capacity,
        occupancyRate: capacity > 0 ? Math.round((sold / capacity) * 100) : 0,
      },
      revenue,
    };
  }

  // ─────────────────────────── 3. Customer ───────────────────────────

  /**
   * The signed-in user's own booking analytics. Saved-events / following
   * "collections" are client-side wishlist state and are intentionally NOT
   * fabricated here; only real booking data is reported.
   */
  async customer(user: RequestUser) {
    const now = new Date();
    const confirmed: Prisma.BookingWhereInput = {
      userId: user.id,
      confirmedAt: { not: null },
    };

    const [upcoming, past, favoriteOrganizers, favoriteVenues] = await Promise.all([
      this.prisma.booking.count({
        where: { ...confirmed, eventSession: { startsAt: { gte: now } } },
      }),
      this.prisma.booking.count({
        where: { ...confirmed, eventSession: { startsAt: { lt: now } } },
      }),
      this.prisma.$queryRaw<{ id: string; name: string; bookings: bigint }[]>`
        SELECT o.id, o.name, COUNT(*)::bigint AS bookings
        FROM "Booking" b
        JOIN "Organization" o ON o.id = b."organizationId"
        WHERE b."userId" = ${user.id} AND b."confirmedAt" IS NOT NULL
        GROUP BY o.id, o.name
        ORDER BY bookings DESC
        LIMIT 5
      `,
      this.prisma.$queryRaw<{ id: string; name: string; city: string; bookings: bigint }[]>`
        SELECT v.id, v.name, v.city, COUNT(*)::bigint AS bookings
        FROM "Booking" b
        JOIN "Event" e ON e.id = b."eventId"
        JOIN "Venue" v ON v.id = e."venueId"
        WHERE b."userId" = ${user.id} AND b."confirmedAt" IS NOT NULL
        GROUP BY v.id, v.name, v.city
        ORDER BY bookings DESC
        LIMIT 5
      `,
    ]);

    return {
      bookings: { upcoming, past, total: upcoming + past },
      favoriteOrganizers: favoriteOrganizers.map((o) => ({
        id: o.id,
        name: o.name,
        bookings: Number(o.bookings),
      })),
      favoriteVenues: favoriteVenues.map((v) => ({
        id: v.id,
        name: v.name,
        city: v.city,
        bookings: Number(v.bookings),
      })),
      // Wishlist / following are client-side collections, surfaced by the web app.
      collectionsNote: 'Saved events and followed organizers are client-side collections.',
    };
  }

  // ─────────────────────────── 4. Platform (admin) ───────────────────────────

  /** Platform analytics: reuse the existing admin dashboard and extend it. */
  async platform() {
    const [dashboard, movieCount, eventCount, retention, checkedInBookings] = await Promise.all([
      this.reports.adminDashboard(),
      this.prisma.event.count({
        where: { experienceType: ExperienceType.MOVIE, status: EventStatus.PUBLISHED },
      }),
      this.prisma.event.count({
        where: { experienceType: ExperienceType.EVENT, status: EventStatus.PUBLISHED },
      }),
      this.repeatCustomers({}),
      this.prisma.booking.count({
        where: { tickets: { some: { status: TicketStatus.CHECKED_IN } } },
      }),
    ]);

    return {
      gmvMinor: dashboard.gmvMinor,
      platformRevenueMinor: dashboard.platformRevenueMinor,
      bookings: dashboard.totalBookings,
      moviesCount: movieCount,
      eventsCount: eventCount,
      retention,
      funnel: {
        created: dashboard.totalBookings,
        confirmed: dashboard.confirmedBookings,
        checkedIn: checkedInBookings,
      },
    };
  }
}
