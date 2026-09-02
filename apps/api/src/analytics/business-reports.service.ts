import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ExperienceType, PayoutStatus, RefundStatus } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { PayoutsService } from '../payouts/payouts.service';
import { AnalyticsService } from './analytics.service';

// ─────────────────────────── Date-range helpers ───────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

function parseFrom(s?: string): Date | null {
  if (!s) return null;
  return new Date(s.length <= 10 ? `${s}T00:00:00.000Z` : s);
}
function parseTo(s?: string): Date | null {
  if (!s) return null;
  return new Date(s.length <= 10 ? `${s}T23:59:59.999Z` : s);
}

/**
 * Resolve an optional `from`/`to` query pair into a concrete range. Defaults to
 * the last 30 days (inclusive). Date-only strings are widened to cover the whole
 * day so a single-day range still captures that day's activity.
 */
export function resolveRange(from?: string, to?: string): { from: Date; to: Date } {
  const toDate = parseTo(to) ?? new Date();
  const fromDate = parseFrom(from) ?? new Date(toDate.getTime() - 30 * DAY_MS);
  return { from: fromDate, to: toDate };
}

/** Normalise a Postgres `date_trunc` value (Date | string) to a YYYY-MM-DD key. */
function dayKey(d: Date | string): string {
  return new Date(d).toISOString().slice(0, 10);
}

// CSV serialization is shared, injection-safe, and lives in one place.
import { toCsv } from '../common/csv';
export { toCsv };

// ─────────────────────────── Report shapes ───────────────────────────

export interface DailyRevenuePoint {
  day: string;
  grossMinor: number;
  platformFeesMinor: number;
  refundsMinor: number;
  netMinor: number;
  bookings: number;
}
export interface DailyRevenueReport {
  from: Date;
  to: Date;
  totals: {
    grossMinor: number;
    platformFeesMinor: number;
    refundsMinor: number;
    netMinor: number;
    bookings: number;
  };
  series: DailyRevenuePoint[];
}

export interface OrganizerRevenueRow {
  organizationId: string;
  organizationName: string;
  grossMinor: number;
  platformFeesMinor: number;
  refundsMinor: number;
  netMinor: number;
  bookings: number;
}

export interface SettlementReport {
  totals: { outstandingMinor: number; paidMinor: number; payoutCount: number };
  byOrg: {
    organizationId: string;
    organizationName: string;
    outstandingMinor: number;
    paidMinor: number;
    outstandingCount: number;
    paidCount: number;
  }[];
  payouts: Awaited<ReturnType<PayoutsService['adminList']>>;
}

/**
 * Business-operations reports (admin-only, read-only). Every figure is composed
 * from the existing analytics/payout aggregate helpers — the only *new* queries
 * are the date-truncated groupings that give a time dimension no helper provides.
 * Nothing here mutates booking / payment / payout state.
 */
@Injectable()
export class BusinessReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
    private readonly payouts: PayoutsService,
  ) {}

  /**
   * Booking scope for the reusable `AnalyticsService.revenue` helper. The helper
   * forces `confirmedAt: { not: null }`, so the range is carried in an `AND`
   * clause (which co-exists with it) rather than on the `confirmedAt` key.
   */
  private confirmedRange(from: Date, to: Date): Prisma.BookingWhereInput {
    return { AND: [{ confirmedAt: { gte: from, lte: to } }] };
  }

  // ─────────────────────── 1. Daily revenue (time series) ───────────────────────

  async dailyRevenue(from: Date, to: Date): Promise<DailyRevenueReport> {
    const [totals, refundTotals, grossByDay, refundByDay] = await Promise.all([
      // Reuse: single-aggregate revenue block (gross + platform fees).
      this.analytics.revenue(this.confirmedRange(from, to)),
      // Reuse: single-aggregate completed-refund block.
      this.analytics.refundStats({ createdAt: { gte: from, lte: to } }),
      // Time dimension: one grouped date_trunc (no per-day loop).
      this.prisma.$queryRaw<
        { day: Date; gross: bigint; bookingfee: bigint; paymentfee: bigint; bookings: bigint }[]
      >`
        SELECT date_trunc('day', "confirmedAt") AS day,
               SUM("subtotalMinor")::bigint AS gross,
               SUM("bookingFeeMinor")::bigint AS bookingfee,
               SUM("paymentFeeMinor")::bigint AS paymentfee,
               COUNT(*)::bigint AS bookings
        FROM "Booking"
        WHERE "confirmedAt" IS NOT NULL AND "confirmedAt" >= ${from} AND "confirmedAt" <= ${to}
        GROUP BY 1 ORDER BY 1 ASC
      `,
      this.prisma.$queryRaw<{ day: Date; refunds: bigint }[]>`
        SELECT date_trunc('day', "createdAt") AS day, SUM("amountMinor")::bigint AS refunds
        FROM "Refund"
        WHERE "status" = 'COMPLETED' AND "createdAt" >= ${from} AND "createdAt" <= ${to}
        GROUP BY 1 ORDER BY 1 ASC
      `,
    ]);

    const byDay = new Map<string, DailyRevenuePoint>();
    for (const r of grossByDay) {
      const key = dayKey(r.day);
      byDay.set(key, {
        day: key,
        grossMinor: Number(r.gross),
        platformFeesMinor: Number(r.bookingfee) + Number(r.paymentfee),
        refundsMinor: 0,
        netMinor: 0,
        bookings: Number(r.bookings),
      });
    }
    for (const r of refundByDay) {
      const key = dayKey(r.day);
      const point =
        byDay.get(key) ??
        ({
          day: key,
          grossMinor: 0,
          platformFeesMinor: 0,
          refundsMinor: 0,
          netMinor: 0,
          bookings: 0,
        } satisfies DailyRevenuePoint);
      point.refundsMinor = Number(r.refunds);
      byDay.set(key, point);
    }
    const series = [...byDay.values()]
      .sort((a, b) => a.day.localeCompare(b.day))
      .map((p) => ({ ...p, netMinor: p.grossMinor - p.refundsMinor }));

    const platformFeesMinor = totals.bookingFeesMinor + totals.paymentFeesMinor;
    return {
      from,
      to,
      totals: {
        grossMinor: totals.grossMinor,
        platformFeesMinor,
        refundsMinor: refundTotals.amountMinor,
        netMinor: totals.grossMinor - refundTotals.amountMinor,
        bookings: totals.confirmedBookings,
      },
      series,
    };
  }

  // ─────────────────────── 2. Organizer revenue (Top Organizers) ───────────────────────

  async organizerRevenue(from: Date, to: Date, limit?: number) {
    const [grouped, refundGroups] = await Promise.all([
      // Single grouped aggregate — one row per org, no per-org fan-out.
      this.prisma.booking.groupBy({
        by: ['organizationId'],
        where: { confirmedAt: { gte: from, lte: to } },
        _sum: {
          subtotalMinor: true,
          organizerFeeMinor: true,
          bookingFeeMinor: true,
          paymentFeeMinor: true,
        },
        _count: { _all: true },
      }),
      this.prisma.refund.groupBy({
        by: ['organizationId'],
        where: { status: RefundStatus.COMPLETED, createdAt: { gte: from, lte: to } },
        _sum: { amountMinor: true },
      }),
    ]);

    const refundByOrg = new Map(
      refundGroups.map((g) => [g.organizationId, g._sum.amountMinor ?? 0]),
    );
    const orgs = await this.prisma.organization.findMany({
      where: { id: { in: grouped.map((g) => g.organizationId) } },
      select: { id: true, name: true },
    });
    const nameByOrg = new Map(orgs.map((o) => [o.id, o.name]));

    let organizers: OrganizerRevenueRow[] = grouped.map((g) => {
      const gross = g._sum.subtotalMinor ?? 0;
      const organizerFee = g._sum.organizerFeeMinor ?? 0;
      const refunds = refundByOrg.get(g.organizationId) ?? 0;
      return {
        organizationId: g.organizationId,
        organizationName: nameByOrg.get(g.organizationId) ?? g.organizationId,
        grossMinor: gross,
        platformFeesMinor: (g._sum.bookingFeeMinor ?? 0) + (g._sum.paymentFeeMinor ?? 0),
        refundsMinor: refunds,
        // Net mirrors PayoutsService.settle: gross − organizer fee − refunds.
        netMinor: gross - organizerFee - refunds,
        bookings: g._count._all,
      };
    });
    organizers.sort((a, b) => b.grossMinor - a.grossMinor);
    if (limit && limit > 0) organizers = organizers.slice(0, limit);
    return { from, to, organizers };
  }

  // ─────────────────────── 3. Settlement / outstanding payouts ───────────────────────

  async settlement(): Promise<SettlementReport> {
    // Reuse PayoutsService.adminList — the payout figures are already computed
    // and snapshotted on each row; we only fold them per org / status here.
    const payouts = await this.payouts.adminList();

    const byOrg = new Map<string, SettlementReport['byOrg'][number]>();
    let outstandingMinor = 0;
    let paidMinor = 0;
    for (const p of payouts) {
      const entry = byOrg.get(p.organizationId) ?? {
        organizationId: p.organizationId,
        organizationName: p.organization?.name ?? p.organizationId,
        outstandingMinor: 0,
        paidMinor: 0,
        outstandingCount: 0,
        paidCount: 0,
      };
      if (p.status === PayoutStatus.PAID) {
        entry.paidMinor += p.netMinor;
        entry.paidCount += 1;
        paidMinor += p.netMinor;
      } else if (p.status === PayoutStatus.PENDING || p.status === PayoutStatus.SCHEDULED) {
        entry.outstandingMinor += p.netMinor;
        entry.outstandingCount += 1;
        outstandingMinor += p.netMinor;
      }
      byOrg.set(p.organizationId, entry);
    }

    return {
      totals: { outstandingMinor, paidMinor, payoutCount: payouts.length },
      byOrg: [...byOrg.values()].sort((a, b) => b.outstandingMinor - a.outstandingMinor),
      payouts,
    };
  }

  // ─────────────────────── 4. Refund report ───────────────────────

  async refunds(from: Date, to: Date) {
    const [totals, byStatusGroups, byDayRaw] = await Promise.all([
      // Reuse: completed-refund aggregate block.
      this.analytics.refundStats({ createdAt: { gte: from, lte: to } }),
      this.prisma.refund.groupBy({
        by: ['status'],
        where: { createdAt: { gte: from, lte: to } },
        _sum: { amountMinor: true },
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<{ day: Date; count: bigint; amount: bigint }[]>`
        SELECT date_trunc('day', "createdAt") AS day,
               COUNT(*)::bigint AS count,
               SUM("amountMinor")::bigint AS amount
        FROM "Refund"
        WHERE "status" = 'COMPLETED' AND "createdAt" >= ${from} AND "createdAt" <= ${to}
        GROUP BY 1 ORDER BY 1 ASC
      `,
    ]);
    return {
      from,
      to,
      totals,
      byStatus: byStatusGroups.map((g) => ({
        status: g.status,
        count: g._count._all,
        amountMinor: g._sum.amountMinor ?? 0,
      })),
      byDay: byDayRaw.map((r) => ({
        day: dayKey(r.day),
        count: Number(r.count),
        amountMinor: Number(r.amount),
      })),
    };
  }

  // ─────────────────────── 5. Platform fees ───────────────────────

  async platformFees(from: Date, to: Date) {
    // Reuse dailyRevenue (which reuses the revenue aggregate) — no new query.
    const daily = await this.dailyRevenue(from, to);
    return {
      from,
      to,
      totals: { platformFeesMinor: daily.totals.platformFeesMinor },
      series: daily.series.map((s) => ({ day: s.day, feesMinor: s.platformFeesMinor })),
    };
  }

  // ─────────────────────── 6. Tax actually charged ───────────────────────

  /**
   * Tax collected in the period, read from what was CHARGED rather than recomputed.
   *
   * ── WHY IT READS THE SNAPSHOT ──────────────────────────────────────────────────────
   * `BookingTaxLine` records the rate, the base and the amount for every levy at the moment
   * of sale. Re-deriving those from today's `TaxRule` rows would report last quarter at this
   * quarter's rates — and rates move: India's whole table changed on 22 September 2025. A
   * report that silently restates history is worse than no report.
   *
   * ── WHAT IT STILL IS NOT ───────────────────────────────────────────────────────────
   * A record of what was charged. Not a return, not GSTR-anything, not an e-invoice, and
   * not reconciled against a ledger. `taxModelled` says whether any tax was configured at
   * all, so a zero here is distinguishable from a platform that never asked the question —
   * this report used to hardcode `false` and zero, which stayed on screen for the whole
   * period after tax became real.
   */
  async tax(from: Date, to: Date) {
    const rev = await this.analytics.revenue(this.confirmedRange(from, to));
    const platformFeesMinor = rev.bookingFeesMinor + rev.paymentFeesMinor;

    const lines = await this.prisma.bookingTaxLine.findMany({
      where: { booking: this.confirmedRange(from, to) },
      select: { label: true, rateBasisPoints: true, baseMinor: true, amountMinor: true },
    });

    /*
      Grouped by label AND rate, because those are different taxes even under one name.
      Cinema at 5% and a concert at 18% are both "CGST"; summing them into one line would
      hide the split a filing has to state.
    */
    const byRate = new Map<
      string,
      { label: string; rateBasisPoints: number; baseMinor: number; amountMinor: number }
    >();
    for (const line of lines) {
      const key = `${line.label}|${line.rateBasisPoints}`;
      const entry = byRate.get(key) ?? {
        label: line.label,
        rateBasisPoints: line.rateBasisPoints,
        baseMinor: 0,
        amountMinor: 0,
      };
      entry.baseMinor += line.baseMinor;
      entry.amountMinor += line.amountMinor;
      byRate.set(key, entry);
    }

    const breakdown = [...byRate.values()].sort(
      (a, b) => a.label.localeCompare(b.label) || a.rateBasisPoints - b.rateBasisPoints,
    );
    const taxCollectedMinor = breakdown.reduce((sum, b) => sum + b.amountMinor, 0);
    const activeRules = await this.prisma.taxRule.count({ where: { active: true } });

    return {
      from,
      to,
      /** Whether any tax rule is configured at all — not whether this period collected any. */
      taxModelled: activeRules > 0,
      taxCollectedMinor,
      /** One row per label+rate, which is the granularity a filing needs. */
      breakdown,
      note:
        activeRules > 0
          ? 'Tax as CHARGED, read from each booking’s snapshot rather than recomputed at ' +
            'today’s rates. This is a record of what was collected — not a return, not a ' +
            'GSTR filing, and not reconciled against a ledger.'
          : 'No tax rule is active, so no tax is being charged. The figures below are the ' +
            'taxable base for reference only.',
      taxableBaseMinor: rev.grossMinor + platformFeesMinor,
      grossMinor: rev.grossMinor,
      platformFeesMinor,
    };
  }

  // ─────────────────────── 7. Top experiences ───────────────────────

  async topExperiences(from: Date, to: Date, limit = 10) {
    // Ranked in SQL (group + order + take), then one title lookup — mirrors the
    // topTicketType pattern; no per-event fan-out.
    const grouped = await this.prisma.booking.groupBy({
      by: ['eventId'],
      where: { confirmedAt: { gte: from, lte: to } },
      _sum: { subtotalMinor: true },
      _count: { _all: true },
      orderBy: { _count: { eventId: 'desc' } },
      take: limit,
    });
    const events = await this.prisma.event.findMany({
      where: { id: { in: grouped.map((g) => g.eventId) } },
      select: { id: true, title: true, experienceType: true, movie: { select: { title: true } } },
    });
    const eventById = new Map(events.map((e) => [e.id, e]));
    return {
      from,
      to,
      experiences: grouped.map((g) => {
        const e = eventById.get(g.eventId);
        return {
          eventId: g.eventId,
          title: e?.title ?? g.eventId,
          experienceType: e?.experienceType ?? ExperienceType.EVENT,
          movieTitle: e?.movie?.title ?? null,
          bookings: g._count._all,
          grossMinor: g._sum.subtotalMinor ?? 0,
        };
      }),
    };
  }

  // ─────────────────────── 8. Growth & retention ───────────────────────

  async growth(from: Date, to: Date) {
    const [retention, newUsersRaw, newBookingsRaw, newOrganizersRaw] = await Promise.all([
      // Reuse: platform retention / repeat-customer block (all-time).
      this.analytics.repeatCustomers({}),
      this.prisma.$queryRaw<{ day: Date; count: bigint }[]>`
        SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::bigint AS count
        FROM "User"
        WHERE "createdAt" >= ${from} AND "createdAt" <= ${to}
        GROUP BY 1 ORDER BY 1 ASC
      `,
      this.prisma.$queryRaw<{ day: Date; count: bigint }[]>`
        SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::bigint AS count
        FROM "Booking"
        WHERE "createdAt" >= ${from} AND "createdAt" <= ${to}
        GROUP BY 1 ORDER BY 1 ASC
      `,
      this.prisma.$queryRaw<{ day: Date; count: bigint }[]>`
        SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::bigint AS count
        FROM "Organization"
        WHERE "createdAt" >= ${from} AND "createdAt" <= ${to}
        GROUP BY 1 ORDER BY 1 ASC
      `,
    ]);
    return {
      from,
      to,
      retention,
      newUsers: newUsersRaw.map((r) => ({ day: dayKey(r.day), count: Number(r.count) })),
      newBookings: newBookingsRaw.map((r) => ({ day: dayKey(r.day), count: Number(r.count) })),
      newOrganizers: newOrganizersRaw.map((r) => ({ day: dayKey(r.day), count: Number(r.count) })),
    };
  }

  /**
   * Payment success rate per provider — the key health metric for a multi-provider
   * platform. Reuses the indexed Payment.status/provider columns; no new pipeline.
   */
  async paymentHealth(from: Date, to: Date) {
    const groups = await this.prisma.payment.groupBy({
      by: ['provider', 'status'],
      where: { createdAt: { gte: from, lte: to } },
      _count: { _all: true },
    });
    const byProvider = new Map<string, { succeeded: number; failed: number; other: number }>();
    for (const g of groups) {
      const row = byProvider.get(g.provider) ?? { succeeded: 0, failed: 0, other: 0 };
      const n = g._count._all;
      if (g.status === 'SUCCEEDED') row.succeeded += n;
      else if (g.status === 'FAILED') row.failed += n;
      else row.other += n;
      byProvider.set(g.provider, row);
    }
    const providers = [...byProvider.entries()].map(([provider, r]) => {
      const settled = r.succeeded + r.failed;
      return {
        provider,
        succeeded: r.succeeded,
        failed: r.failed,
        pending: r.other,
        // Success rate over settled (succeeded+failed) attempts; null when none settled.
        successRate: settled === 0 ? null : Math.round((r.succeeded / settled) * 1000) / 10,
      };
    });
    const totals = providers.reduce(
      (a, p) => ({ succeeded: a.succeeded + p.succeeded, failed: a.failed + p.failed }),
      { succeeded: 0, failed: 0 },
    );
    const settled = totals.succeeded + totals.failed;
    return {
      from,
      to,
      overallSuccessRate:
        settled === 0 ? null : Math.round((totals.succeeded / settled) * 1000) / 10,
      providers: providers.sort((a, b) => b.succeeded + b.failed - (a.succeeded + a.failed)),
    };
  }

  // ─────────────────────── CSV export builders ───────────────────────

  async dailyRevenueCsv(from: Date, to: Date): Promise<string> {
    const r = await this.dailyRevenue(from, to);
    return toCsv(
      ['day', 'grossMinor', 'platformFeesMinor', 'refundsMinor', 'netMinor', 'bookings'],
      r.series.map((s) => [
        s.day,
        s.grossMinor,
        s.platformFeesMinor,
        s.refundsMinor,
        s.netMinor,
        s.bookings,
      ]),
    );
  }

  async organizerRevenueCsv(from: Date, to: Date, limit?: number): Promise<string> {
    const r = await this.organizerRevenue(from, to, limit);
    return toCsv(
      [
        'organizationId',
        'organizationName',
        'grossMinor',
        'platformFeesMinor',
        'refundsMinor',
        'netMinor',
        'bookings',
      ],
      r.organizers.map((o) => [
        o.organizationId,
        o.organizationName,
        o.grossMinor,
        o.platformFeesMinor,
        o.refundsMinor,
        o.netMinor,
        o.bookings,
      ]),
    );
  }

  async refundsCsv(from: Date, to: Date): Promise<string> {
    const r = await this.refunds(from, to);
    return toCsv(
      ['day', 'count', 'amountMinor'],
      r.byDay.map((d) => [d.day, d.count, d.amountMinor]),
    );
  }

  async settlementCsv(): Promise<string> {
    const r = await this.settlement();
    return toCsv(
      [
        'organizationId',
        'organizationName',
        'outstandingMinor',
        'outstandingCount',
        'paidMinor',
        'paidCount',
      ],
      r.byOrg.map((o) => [
        o.organizationId,
        o.organizationName,
        o.outstandingMinor,
        o.outstandingCount,
        o.paidMinor,
        o.paidCount,
      ]),
    );
  }
}
