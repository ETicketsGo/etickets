import { HttpStatus, Injectable } from '@nestjs/common';
import {
  deriveEventSummary,
  deriveGrowthRecommendations,
  formatMinor,
  type EventSummary,
  type GrowthRecommendation,
} from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { ReportsService } from '../reports/reports.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { AiGateway } from '../ai/ai-gateway.service';
import { AiConfigService } from '../ai/ai-config.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';

/**
 * Organizer AI features (v2.0 WS2/WS3/WS4). Every answer is sourced from the existing
 * org-scoped reports/analytics — no fabricated metrics. AI (when enabled) only
 * rephrases; disabled by default, so the deterministic result is authoritative.
 * Read-only: no financial, publishing or inventory actions.
 */
@Injectable()
export class OrganizerAiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reports: ReportsService,
    private readonly analytics: AnalyticsService,
    private readonly gateway: AiGateway,
    private readonly ai: AiConfigService,
  ) {}

  /** Days until the next upcoming session (null if none). */
  private async daysToEvent(eventId: string): Promise<number | null> {
    const sessions = await this.prisma.eventSession.findMany({
      where: { eventId },
      select: { startsAt: true },
    });
    const now = Date.now();
    const future = sessions
      .map((s) => s.startsAt.getTime())
      .filter((t) => t >= now)
      .sort((a, b) => a - b);
    return future.length ? Math.round((future[0] - now) / 86_400_000) : null;
  }

  /** Deterministic event summary (WS3) with optional AI-rephrased narrative. */
  async eventSummary(user: RequestUser, eventId: string) {
    const report = await this.reports.organizerEventReport(user, eventId); // asserts access
    if (!report)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Event not found.', HttpStatus.NOT_FOUND);
    const commerce = await this.reports.organizerCommerceReport(user, eventId);
    const days = await this.daysToEvent(eventId);
    const couponRedemptions = await this.prisma.booking.count({
      where: { eventId, couponId: { not: null }, confirmedAt: { not: null } },
    });

    const summary: EventSummary = deriveEventSummary({
      title: report.event.title,
      currency: 'INR',
      grossTicketSalesMinor: report.grossTicketSalesMinor,
      netOrganizerRevenueMinor: report.netOrganizerRevenueMinor,
      refundsMinor: report.refundsMinor,
      ticketsSold: report.ticketsSold,
      ticketsRemaining: report.ticketsRemaining,
      checkInCount: report.checkInCount,
      salesByTicketType: report.salesByTicketType,
      salesByDay: report.salesByDay.map((d) => ({
        day: new Date(d.day).toISOString().slice(0, 10),
        bookings: d.bookings,
        grossMinor: d.grossMinor,
      })),
      daysToEvent: days,
      couponRedemptions,
      couponCount: couponRedemptions > 0 ? 1 : 0,
      commerce: commerce
        ? {
            addOnRevenueMinor: commerce.addOnRevenueMinor,
            bundleRevenueMinor: commerce.bundleRevenueMinor,
            donationTotalMinor: commerce.donationTotalMinor,
          }
        : undefined,
    });

    // Optional AI polish — rephrases the deterministic narrative, never new facts.
    const ai = await this.gateway.run({
      feature: 'event.summary',
      promptKey: 'event.summary',
      input: summary.narrative,
      actorUserId: user.id,
    });

    return {
      aiEnabled: this.ai.isEnabled(),
      generated: ai.ok,
      summary,
      narrative: ai.ok && ai.text ? ai.text : summary.narrative,
    };
  }

  /** Deterministic growth recommendations (WS4). */
  async growthRecommendations(
    user: RequestUser,
    eventId: string,
  ): Promise<{ recommendations: GrowthRecommendation[] }> {
    const report = await this.reports.organizerEventReport(user, eventId); // asserts access
    if (!report)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Event not found.', HttpStatus.NOT_FOUND);
    const commerce = await this.reports.organizerCommerceReport(user, eventId);
    const days = await this.daysToEvent(eventId);
    const couponRedemptions = await this.prisma.booking.count({
      where: { eventId, couponId: { not: null }, confirmedAt: { not: null } },
    });

    const recommendations = deriveGrowthRecommendations({
      currency: 'INR',
      ticketsSold: report.ticketsSold,
      ticketsRemaining: report.ticketsRemaining,
      grossTicketSalesMinor: report.grossTicketSalesMinor,
      refundsMinor: report.refundsMinor,
      daysToEvent: days,
      salesByTicketType: report.salesByTicketType,
      couponRedemptions,
      bundles: commerce?.bundles ?? [],
    });
    return { recommendations };
  }

  /**
   * Organizer assistant (WS2): answers a bounded set of questions from authoritative
   * org-scoped analytics. Read-only, org-scoped, never fabricates. Deterministic
   * intent matching; AI is not required.
   */
  async ask(user: RequestUser, organizationId: string, question: string) {
    const analytics = await this.analytics.organizer(user, organizationId); // asserts membership
    const q = question.toLowerCase();
    const sources: string[] = [];
    let answer: string;

    if (/refund/.test(q)) {
      /*
        One clause per currency, joined — never a single figure.

        These answers used to read the organization's totals as one number, which is only a
        number when the organization sells in one currency. An organizer with venues in two
        countries was told their refunds came to a sum of rupees and dollars added together,
        in a sentence with a single symbol on it.
      */
      const r = analytics.refunds;
      answer = r
        ? r.length === 0
          ? 'No refunds have been completed.'
          : `Refunds: ${r
              .map((x) => `${x.count} totalling ${formatMinor(x.amountMinor, x.currency)}`)
              .join('; ')}.`
        : 'Refund figures are restricted to owners and managers.';
      sources.push('analytics.refunds');
    } else if (/best|top|which ticket/.test(q)) {
      const t = analytics.topTicketType;
      answer = t
        ? `Your best-selling ticket type is "${t.name}" with ${t.quantity} sold.`
        : 'No ticket sales yet.';
      sources.push('analytics.topTicketType');
    } else if (/coupon/.test(q)) {
      const c = analytics.coupons;
      answer = c
        ? c.length === 0
          ? 'No confirmed booking has used a coupon.'
          : `${c.reduce((n, x) => n + x.redemptions, 0)} confirmed booking(s) used a coupon, ` +
            `discounting ${c.map((x) => formatMinor(x.discountMinor, x.currency)).join(' and ')}.`
        : 'Coupon figures are restricted to owners and managers.';
      sources.push('analytics.coupons');
    } else if (/today/.test(q)) {
      /*
        Behind the same financial gate as the refund and coupon answers.

        `todaysSales` queries bookings directly rather than reading the analytics, so it did not
        inherit the gate those answers get for free — and a check-in staff member who asked
        "how much did we sell today?" was told the organization's takings. `revenue` is present
        on the analytics exactly when the caller may see money, so it is the gate here too.
      */
      answer = analytics.revenue
        ? await this.todaysSales(organizationId)
        : 'Sales figures are restricted to owners and managers.';
      sources.push('bookings.today');
    } else if (/review|before|prepare|checklist/.test(q)) {
      // Already a percentage — the same double multiplication as the conversion rate below.
      const util = Math.round(analytics.capacity.utilization);
      answer =
        `Before your event: ${util}% of capacity is sold. ` +
        'Confirm ticket types are on sale, coupons are valid, and enough check-in devices are ready.';
      sources.push('analytics.capacity');
    } else if (/sell|sales|performing|revenue|how are/.test(q)) {
      const conv = analytics.conversion;
      const rev = analytics.revenue;
      const gross =
        rev && rev.length > 0
          ? rev.map((r) => formatMinor(r.grossMinor, r.currency)).join(' and ')
          : null;
      answer =
        // `conversion.rate` is already a percentage; multiplying again printed "5200%" (found by QA).
        `${conv.confirmed} confirmed of ${conv.total} bookings (${Math.round(conv.rate)}% conversion)` +
        (gross ? `, ${gross} gross.` : '.');
      sources.push('analytics.conversion', 'analytics.revenue');
    } else {
      answer =
        'I can answer questions about sales performance, best-selling ticket types, refund rate, ' +
        'coupon usage, today’s sales, and what to review before your event.';
    }

    // Optional AI rephrasing (disabled by default → returns the deterministic answer).
    const ai = await this.gateway.run({
      feature: 'organizer.assistant',
      promptKey: 'organizer.assistant',
      input: `Question: ${question}\nFacts: ${answer}`,
      organizationId,
      actorUserId: user.id,
    });

    return {
      aiEnabled: this.ai.isEnabled(),
      generated: ai.ok,
      answer: ai.ok && ai.text ? ai.text : answer,
      sources,
    };
  }

  private async todaysSales(organizationId: string): Promise<string> {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    /*
      One figure per currency, like the refund and coupon answers. This summed every booking into
      one number printed without a currency, so an organizer selling in two markets was told
      "totalling INR 57.2" — rupees and dollars added together (found by QA).
    */
    const byCurrency = await this.prisma.booking.groupBy({
      by: ['currency'],
      where: { organizationId, confirmedAt: { gte: start } },
      _sum: { totalMinor: true },
      _count: { _all: true },
    });
    const count = byCurrency.reduce((n, row) => n + row._count._all, 0);
    return count > 0
      ? `Today: ${count} confirmed booking(s) totalling ${byCurrency
          .map((row) => formatMinor(row._sum.totalMinor ?? 0, row.currency))
          .join(' and ')}.`
      : 'No confirmed bookings yet today.';
  }
}
