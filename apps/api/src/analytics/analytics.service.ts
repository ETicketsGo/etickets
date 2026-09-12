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

/**
 * Money, with the currency it is in.
 *
 * ── WHY EVERY AGGREGATE NEEDS THIS ─────────────────────────────────────────────────
 * `SUM("subtotalMinor")` over a set of bookings is only a number if every booking is in the
 * same currency. The platform sells in eight, an organizer may hold venues in more than one,
 * and nothing in these queries filtered on it — so a report covering a ₹799 sale and a $20
 * sale returned 81,900 minor units of nothing at all, formatted with whichever symbol the
 * page happened to default to.
 *
 * It reads as a formatting bug and is not one. The addition itself is invalid, and no symbol
 * makes it valid. So the aggregates group by currency and the callers render one block each;
 * there is no code path left that can add two currencies together.
 */
export interface CurrencyRevenue extends RevenueMetrics {
  currency: string;
}
export interface CurrencyRefunds extends RefundMetrics {
  currency: string;
}

/** One market an organization actually trades in, and what it took there. */
export interface CountryRevenue {
  /** As stored on the venue: "India", "United States". */
  country: string;
  currency: string;
  grossMinor: number;
  bookings: number;
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
  /**
   * Present only for OWNER/MANAGER + platform admins.
   *
   * ── ONE BLOCK PER CURRENCY, NOT ONE TOTAL ──────────────────────────────────────
   * `revenue` used to be a single set of figures summed across every booking the
   * organization had ever taken. For an organizer selling in one country that was right; for
   * one selling in two it was arithmetic on incompatible units, presented with whichever
   * symbol the dashboard defaulted to.
   *
   * There is no correct single total — a platform with no exchange-rate source cannot make
   * one, and inventing a "reporting currency" would put a number on the screen that nobody
   * was ever charged. So the answer is a list, and a dashboard showing an organizer with one
   * currency sees exactly what it always did.
   */
  revenue?: CurrencyRevenue[];
  refunds?: (CurrencyRefunds & { refundRate: number })[];
  coupons?: { currency: string; redemptions: number; discountMinor: number }[];
  /** Where the money came from, so a multi-country organizer can see the split. */
  countries?: CountryRevenue[];
  topEvents?: {
    eventId: string;
    title: string;
    currency: string;
    grossMinor: number;
    bookings: number;
  }[];
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

  /**
   * The same revenue block, split by the currency it was taken in.
   *
   * One grouped aggregate rather than a query per currency: the set of currencies is whatever
   * is in the data, and asking the database which ones exist is cheaper and more honest than
   * a list maintained here.
   */
  async revenueByCurrency(where: Prisma.BookingWhereInput): Promise<CurrencyRevenue[]> {
    const groups = await this.prisma.booking.groupBy({
      by: ['currency'],
      where: { ...where, confirmedAt: { not: null } },
      _sum: {
        subtotalMinor: true,
        bookingFeeMinor: true,
        paymentFeeMinor: true,
        organizerFeeMinor: true,
        discountMinor: true,
      },
      _count: { _all: true },
    });
    return groups
      .map((g) => {
        const grossMinor = g._sum.subtotalMinor ?? 0;
        const organizerFeesMinor = g._sum.organizerFeeMinor ?? 0;
        return {
          currency: g.currency,
          grossMinor,
          bookingFeesMinor: g._sum.bookingFeeMinor ?? 0,
          paymentFeesMinor: g._sum.paymentFeeMinor ?? 0,
          organizerFeesMinor,
          discountMinor: g._sum.discountMinor ?? 0,
          netMinor: grossMinor - organizerFeesMinor,
          confirmedBookings: g._count._all,
        };
      })
      .sort((a, b) => b.grossMinor - a.grossMinor);
  }

  /**
   * Completed refunds, split by the currency of the booking they returned money from.
   *
   * A raw join rather than a Prisma `groupBy`: the currency is on `Booking`, and Prisma
   * cannot group by a field on a relation. Denormalising a `currency` column onto `Refund`
   * would also work and is the better long-term shape — but it is a money table, and adding
   * a column to one to make a report easier is not a trade worth making today.
   */
  async refundStatsByCurrency(where: {
    organizationId?: string;
    from?: Date;
    to?: Date;
  }): Promise<CurrencyRefunds[]> {
    const rows = await this.prisma.$queryRaw<{ currency: string; count: bigint; amount: bigint }[]>`
      SELECT b."currency" AS currency,
             COUNT(*)::bigint AS count,
             SUM(r."amountMinor")::bigint AS amount
      FROM "Refund" r
      JOIN "Booking" b ON b."id" = r."bookingId"
      WHERE r."status" = 'COMPLETED'
        AND (${where.organizationId ?? null}::text IS NULL OR r."organizationId" = ${where.organizationId ?? null})
        AND (${where.from ?? null}::timestamptz IS NULL OR r."createdAt" >= ${where.from ?? null})
        AND (${where.to ?? null}::timestamptz IS NULL OR r."createdAt" <= ${where.to ?? null})
      GROUP BY 1
    `;
    return rows.map((r) => ({
      currency: r.currency,
      count: Number(r.count),
      amountMinor: Number(r.amount),
    }));
  }

  /**
   * What an organization took in each COUNTRY it sells in.
   *
   * Country rather than currency, because that is the question an operator asks: "how is my
   * India business doing against my US one". The two happen to line up across the platform's
   * eight markets, but they are not the same question — a currency is a property of the
   * money, a country is a property of the business — and the country is the one they can act
   * on.
   *
   * Taken from the VENUE, which is where the event was held and therefore what decided the
   * currency, the tax rules and the payment route.
   */
  async countryRevenue(organizationId: string): Promise<CountryRevenue[]> {
    const rows = await this.prisma.$queryRaw<
      { country: string; currency: string; gross: bigint; bookings: bigint }[]
    >`
      SELECT v."country" AS country,
             b."currency" AS currency,
             SUM(b."subtotalMinor")::bigint AS gross,
             COUNT(*)::bigint AS bookings
      FROM "Booking" b
      JOIN "Event" e ON e."id" = b."eventId"
      JOIN "Venue" v ON v."id" = e."venueId"
      WHERE b."organizationId" = ${organizationId} AND b."confirmedAt" IS NOT NULL
      GROUP BY 1, 2
      ORDER BY 3 DESC
    `;
    return rows.map((r) => ({
      country: r.country,
      currency: r.currency,
      grossMinor: Number(r.gross),
      bookings: Number(r.bookings),
    }));
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

  /** Confirmed bookings that redeemed a coupon, and what was discounted, per currency. */
  private async couponRedemptions(
    where: Prisma.BookingWhereInput,
  ): Promise<{ currency: string; redemptions: number; discountMinor: number }[]> {
    const groups = await this.prisma.booking.groupBy({
      by: ['currency'],
      where: { ...where, confirmedAt: { not: null }, couponId: { not: null } },
      _sum: { discountMinor: true },
      _count: { _all: true },
    });
    return groups.map((g) => ({
      currency: g.currency,
      redemptions: g._count._all,
      discountMinor: g._sum.discountMinor ?? 0,
    }));
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
      countries,
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
      showFinancials ? this.revenueByCurrency({ organizationId }) : Promise.resolve(null),
      showFinancials ? this.refundStatsByCurrency({ organizationId }) : Promise.resolve(null),
      showFinancials ? this.couponRedemptions({ organizationId }) : Promise.resolve([]),
      showFinancials ? this.topEvents(organizationId) : Promise.resolve(null),
      showFinancials ? this.countryRevenue(organizationId) : Promise.resolve(null),
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
      /*
        Refunds are netted off WITHIN a currency, never across.

        A dollar refund does not reduce rupee revenue, and a refund rate computed by dividing
        one by the other is a percentage of nothing. Matching on currency also means an
        organizer with refunds in a currency they no longer sell in still sees them, as their
        own row, rather than having them quietly subtracted from an unrelated total.
      */
      const refundByCurrency = new Map(refunds.map((r) => [r.currency, r]));
      result.revenue = revenue.map((r) => {
        const refunded = refundByCurrency.get(r.currency)?.amountMinor ?? 0;
        return { ...r, netMinor: r.netMinor - refunded };
      });
      result.refunds = refunds.map((r) => {
        const gross = revenue.find((v) => v.currency === r.currency)?.grossMinor ?? 0;
        return { ...r, refundRate: gross > 0 ? Math.round((r.amountMinor / gross) * 100) : 0 };
      });
      result.coupons = couponRedemptions;
      result.countries = countries ?? [];
      result.topEvents = topEvents ?? [];
    }
    return result;
  }

  /** Top events by gross confirmed sales for an organization (financials only). */
  /**
   * Best-selling events, each carrying the currency it sold in.
   *
   * Grouped by currency as well as event, because a "top 5 by revenue" list ordered on raw
   * minor units ranks a $500 event below a ₹600 one. An event sells in exactly one currency,
   * so this adds a label rather than splitting any row — and the caller can rank within a
   * currency instead of across all of them.
   */
  private async topEvents(organizationId: string) {
    const groups = await this.prisma.booking.groupBy({
      by: ['eventId', 'currency'],
      where: { organizationId, confirmedAt: { not: null } },
      _sum: { subtotalMinor: true },
      _count: { _all: true },
      orderBy: { _sum: { subtotalMinor: 'desc' } },
      take: 10,
    });
    const events = await this.prisma.event.findMany({
      where: { id: { in: groups.map((g) => g.eventId) } },
      select: { id: true, title: true },
    });
    const titles = new Map(events.map((e) => [e.id, e.title]));
    return groups.map((g) => ({
      eventId: g.eventId,
      title: titles.get(g.eventId) ?? 'Untitled',
      currency: g.currency,
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
    /*
      Money only for those who may see money — the same gate `organizer()` applies.

      Membership alone let check-in staff read a venue's gross and net revenue here, while the
      organization dashboard withheld exactly those figures from them. Occupancy is operational
      and stays; the revenue block is omitted and its query never runs.
    */
    const showFinancials = await this.canViewFinancials(user, venue.organizationId);

    const [eventCount, sessionCount, revenue, seatOcc, gaOcc] = await Promise.all([
      this.prisma.event.count({ where: { venueId } }),
      this.prisma.eventSession.count({ where: { event: { venueId } } }),
      showFinancials ? this.revenue({ event: { venueId } }) : Promise.resolve(null),
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
      // Omitted, not zeroed: a zero would tell a check-in steward the venue took nothing.
      ...(showFinancials && revenue ? { revenue } : {}),
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
      // Per currency, as the dashboard reports it. The two totals below add currencies together.
      money: dashboard.money,
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
