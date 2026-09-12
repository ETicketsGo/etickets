import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ExperienceType, PayoutStatus } from '@eticketsgo/shared-types';
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

/**
 * A whole report, for one currency.
 *
 * ── WHY THE REPORT IS A LIST NOW ───────────────────────────────────────────────────
 * These figures were `SUM("subtotalMinor")` across every booking on the platform. That is a
 * valid number only while every seller is in one country. The moment a second currency
 * appears it is rupees plus dollars, printed with one symbol, in a report an operator uses to
 * decide things.
 *
 * There is no correct combined total to offer instead: converting needs an exchange-rate
 * source this platform does not have and a rate valid at the time of each sale. So the report
 * is per currency, and an operator reading a single-currency platform sees exactly what they
 * saw before.
 */
export interface CurrencyRevenueReport {
  currency: string;
  totals: {
    grossMinor: number;
    platformFeesMinor: number;
    refundsMinor: number;
    netMinor: number;
    bookings: number;
  };
  series: DailyRevenuePoint[];
}

export interface DailyRevenueReport {
  from: Date;
  to: Date;
  /** One entry per currency traded in the window, largest gross first. */
  byCurrency: CurrencyRevenueReport[];
}

export interface OrganizerRevenueRow {
  organizationId: string;
  organizationName: string;
  /** An organization selling in two currencies appears once per currency. */
  currency: string;
  grossMinor: number;
  platformFeesMinor: number;
  refundsMinor: number;
  netMinor: number;
  bookings: number;
}

export interface SettlementOrgRow {
  organizationId: string;
  organizationName: string;
  currency: string;
  outstandingMinor: number;
  paidMinor: number;
  outstandingCount: number;
  paidCount: number;
}

/** One currency's payouts — an organizer paid in two currencies appears in both. */
export interface CurrencySettlementReport {
  currency: string;
  totals: { outstandingMinor: number; paidMinor: number; payoutCount: number };
  byOrg: SettlementOrgRow[];
}

export interface SettlementReport {
  byCurrency: CurrencySettlementReport[];
  payouts: Awaited<ReturnType<PayoutsService['adminList']>>;
}

/** Every report below that carries money is folded per currency by this. */
function blockFor<T>(blocks: Map<string, T>, currency: string, create: () => T): T {
  const existing = blocks.get(currency);
  if (existing) return existing;
  const created = create();
  blocks.set(currency, created);
  return created;
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
    /*
      Every query here carries `currency` in its GROUP BY.

      The previous version summed each column across all bookings and then handed the result
      to a page that formatted it with one symbol. Adding a currency column to the grouping is
      the entire fix — the totals were never a formatting problem, they were an invalid sum.
    */
    const [revenueRows, refundRows, grossByDay, refundByDay] = await Promise.all([
      this.analytics.revenueByCurrency(this.confirmedRange(from, to)),
      this.analytics.refundStatsByCurrency({ from, to }),
      this.prisma.$queryRaw<
        {
          day: Date;
          currency: string;
          gross: bigint;
          bookingfee: bigint;
          paymentfee: bigint;
          bookings: bigint;
        }[]
      >`
        SELECT date_trunc('day', "confirmedAt") AS day,
               "currency" AS currency,
               SUM("subtotalMinor")::bigint AS gross,
               SUM("bookingFeeMinor")::bigint AS bookingfee,
               SUM("paymentFeeMinor")::bigint AS paymentfee,
               COUNT(*)::bigint AS bookings
        FROM "Booking"
        WHERE "confirmedAt" IS NOT NULL AND "confirmedAt" >= ${from} AND "confirmedAt" <= ${to}
        GROUP BY 1, 2 ORDER BY 1 ASC
      `,
      this.prisma.$queryRaw<{ day: Date; currency: string; refunds: bigint }[]>`
        SELECT date_trunc('day', r."createdAt") AS day,
               b."currency" AS currency,
               SUM(r."amountMinor")::bigint AS refunds
        FROM "Refund" r
        JOIN "Booking" b ON b."id" = r."bookingId"
        WHERE r."status" = 'COMPLETED' AND r."createdAt" >= ${from} AND r."createdAt" <= ${to}
        GROUP BY 1, 2 ORDER BY 1 ASC
      `,
    ]);

    const refundTotals = new Map(refundRows.map((r) => [r.currency, r.amountMinor]));
    /** currency → day → point. */
    const byCurrency = new Map<string, Map<string, DailyRevenuePoint>>();
    const dayMap = (currency: string) => {
      const existing = byCurrency.get(currency);
      if (existing) return existing;
      const created = new Map<string, DailyRevenuePoint>();
      byCurrency.set(currency, created);
      return created;
    };
    const point = (currency: string, key: string): DailyRevenuePoint => {
      const days = dayMap(currency);
      const found = days.get(key);
      if (found) return found;
      const created: DailyRevenuePoint = {
        day: key,
        grossMinor: 0,
        platformFeesMinor: 0,
        refundsMinor: 0,
        netMinor: 0,
        bookings: 0,
      };
      days.set(key, created);
      return created;
    };

    for (const r of grossByDay) {
      const p = point(r.currency, dayKey(r.day));
      p.grossMinor = Number(r.gross);
      p.platformFeesMinor = Number(r.bookingfee) + Number(r.paymentfee);
      p.bookings = Number(r.bookings);
    }
    for (const r of refundByDay) {
      point(r.currency, dayKey(r.day)).refundsMinor = Number(r.refunds);
    }

    const reports = revenueRows.map((rev) => {
      const refundsMinor = refundTotals.get(rev.currency) ?? 0;
      const series = [...(byCurrency.get(rev.currency)?.values() ?? [])]
        .sort((a, b) => a.day.localeCompare(b.day))
        .map((p) => ({ ...p, netMinor: p.grossMinor - p.refundsMinor }));
      return {
        currency: rev.currency,
        totals: {
          grossMinor: rev.grossMinor,
          platformFeesMinor: rev.bookingFeesMinor + rev.paymentFeesMinor,
          refundsMinor,
          netMinor: rev.grossMinor - refundsMinor,
          bookings: rev.confirmedBookings,
        },
        series,
      };
    });

    /*
      A currency with refunds but no sales in the window still gets a block. Dropping it would
      hide money that moved — the one thing a revenue report must not do.
    */
    for (const r of refundRows) {
      if (reports.some((x) => x.currency === r.currency)) continue;
      reports.push({
        currency: r.currency,
        totals: {
          grossMinor: 0,
          platformFeesMinor: 0,
          refundsMinor: r.amountMinor,
          netMinor: -r.amountMinor,
          bookings: 0,
        },
        series: [...(byCurrency.get(r.currency)?.values() ?? [])]
          .sort((a, b) => a.day.localeCompare(b.day))
          .map((p) => ({ ...p, netMinor: p.grossMinor - p.refundsMinor })),
      });
    }

    return {
      from,
      to,
      byCurrency: reports.sort((a, b) => b.totals.grossMinor - a.totals.grossMinor),
    };
  }

  // ─────────────────────── 2. Organizer revenue (Top Organizers) ───────────────────────

  async organizerRevenue(from: Date, to: Date, limit?: number) {
    const [grouped, refundGroups] = await Promise.all([
      /*
        Grouped by organization AND currency.

        An organization selling in two countries appears twice — once per currency — rather
        than once with the two added together. That is not a presentation choice: the sum of a
        rupee and a dollar is not a quantity, and a "Top Organizers" table ordered on it ranks
        by an accident of exchange rates nobody applied.
      */
      this.prisma.booking.groupBy({
        by: ['organizationId', 'currency'],
        where: { confirmedAt: { gte: from, lte: to } },
        _sum: {
          subtotalMinor: true,
          organizerFeeMinor: true,
          bookingFeeMinor: true,
          paymentFeeMinor: true,
        },
        _count: { _all: true },
      }),
      // Refunds carry no currency of their own; the booking they returned money from does.
      this.prisma.$queryRaw<{ organizationid: string; currency: string; amount: bigint }[]>`
        SELECT r."organizationId" AS organizationid,
               b."currency" AS currency,
               SUM(r."amountMinor")::bigint AS amount
        FROM "Refund" r
        JOIN "Booking" b ON b."id" = r."bookingId"
        WHERE r."status" = 'COMPLETED' AND r."createdAt" >= ${from} AND r."createdAt" <= ${to}
        GROUP BY 1, 2
      `,
    ]);

    const key = (organizationId: string, currency: string) => `${organizationId}|${currency}`;
    const refundByOrg = new Map(
      refundGroups.map((g) => [key(g.organizationid, g.currency), Number(g.amount)]),
    );
    const orgs = await this.prisma.organization.findMany({
      where: { id: { in: grouped.map((g) => g.organizationId) } },
      select: { id: true, name: true },
    });
    const nameByOrg = new Map(orgs.map((o) => [o.id, o.name]));

    let organizers: OrganizerRevenueRow[] = grouped.map((g) => {
      const gross = g._sum.subtotalMinor ?? 0;
      const organizerFee = g._sum.organizerFeeMinor ?? 0;
      const refunds = refundByOrg.get(key(g.organizationId, g.currency)) ?? 0;
      return {
        organizationId: g.organizationId,
        organizationName: nameByOrg.get(g.organizationId) ?? g.organizationId,
        currency: g.currency,
        grossMinor: gross,
        platformFeesMinor: (g._sum.bookingFeeMinor ?? 0) + (g._sum.paymentFeeMinor ?? 0),
        refundsMinor: refunds,
        // Net mirrors PayoutsService.settle: gross − organizer fee − refunds.
        netMinor: gross - organizerFee - refunds,
        bookings: g._count._all,
      };
    });
    /*
      Sorted within a currency, then by currency, so the ordering never compares two units.
      A single-currency platform reads exactly as it did.
    */
    organizers.sort((a, b) => a.currency.localeCompare(b.currency) || b.grossMinor - a.grossMinor);
    if (limit && limit > 0) {
      const seen = new Map<string, number>();
      organizers = organizers.filter((row) => {
        const n = (seen.get(row.currency) ?? 0) + 1;
        seen.set(row.currency, n);
        return n <= limit;
      });
    }
    return { from, to, organizers };
  }

  // ─────────────────────── 3. Settlement / outstanding payouts ───────────────────────

  async settlement(): Promise<SettlementReport> {
    // Reuse PayoutsService.adminList — the payout figures are already computed
    // and snapshotted on each row; we only fold them per org / status here.
    const payouts = await this.payouts.adminList();

    /*
      Folded per currency before per organization.

      Payouts have been one per currency since the payout fix, but this report added every
      payout's `netMinor` into one outstanding figure and the page printed it in rupees — a
      dollar payout was owed as that many paise. Each currency is its own block, as in the
      revenue and platform-fee reports.
    */
    const blocks = new Map<
      string,
      { totals: CurrencySettlementReport['totals']; byOrg: Map<string, SettlementOrgRow> }
    >();
    for (const p of payouts) {
      const currency = p.currency.toUpperCase();
      const block = blockFor(blocks, currency, () => ({
        totals: { outstandingMinor: 0, paidMinor: 0, payoutCount: 0 },
        byOrg: new Map<string, SettlementOrgRow>(),
      }));
      block.totals.payoutCount += 1;
      const entry = blockFor(block.byOrg, p.organizationId, () => ({
        organizationId: p.organizationId,
        organizationName: p.organization?.name ?? p.organizationId,
        currency,
        outstandingMinor: 0,
        paidMinor: 0,
        outstandingCount: 0,
        paidCount: 0,
      }));
      if (p.status === PayoutStatus.PAID) {
        entry.paidMinor += p.netMinor;
        entry.paidCount += 1;
        block.totals.paidMinor += p.netMinor;
      } else if (p.status === PayoutStatus.PENDING || p.status === PayoutStatus.SCHEDULED) {
        entry.outstandingMinor += p.netMinor;
        entry.outstandingCount += 1;
        block.totals.outstandingMinor += p.netMinor;
      }
    }

    return {
      byCurrency: [...blocks.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, block]) => ({
          currency,
          totals: block.totals,
          byOrg: [...block.byOrg.values()].sort((a, b) => b.outstandingMinor - a.outstandingMinor),
        })),
      payouts,
    };
  }

  // ─────────────────────── 4. Refund report ───────────────────────

  async refunds(from: Date, to: Date) {
    /*
      Per currency, like every other money figure here. A refund has no currency column; it is
      returned in its booking's, so each grouping joins the booking for it — the same join the
      daily revenue report already makes.
    */
    const [totals, byStatusRaw, byDayRaw] = await Promise.all([
      // Reuse: completed-refund aggregate block, split by currency.
      this.analytics.refundStatsByCurrency({ from, to }),
      this.prisma.$queryRaw<{ currency: string; status: string; count: bigint; amount: bigint }[]>`
        SELECT b."currency" AS currency,
               r."status"::text AS status,
               COUNT(*)::bigint AS count,
               COALESCE(SUM(r."amountMinor"), 0)::bigint AS amount
        FROM "Refund" r
        JOIN "Booking" b ON b."id" = r."bookingId"
        WHERE r."createdAt" >= ${from} AND r."createdAt" <= ${to}
        GROUP BY 1, 2
      `,
      this.prisma.$queryRaw<{ day: Date; currency: string; count: bigint; amount: bigint }[]>`
        SELECT date_trunc('day', r."createdAt") AS day,
               b."currency" AS currency,
               COUNT(*)::bigint AS count,
               SUM(r."amountMinor")::bigint AS amount
        FROM "Refund" r
        JOIN "Booking" b ON b."id" = r."bookingId"
        WHERE r."status" = 'COMPLETED' AND r."createdAt" >= ${from} AND r."createdAt" <= ${to}
        GROUP BY 1, 2 ORDER BY 1 ASC
      `,
    ]);

    type Block = {
      currency: string;
      totals: { count: number; amountMinor: number };
      byStatus: { status: string; count: number; amountMinor: number }[];
      byDay: { day: string; count: number; amountMinor: number }[];
    };
    const blocks = new Map<string, Block>();
    const block = (currency: string) =>
      blockFor(blocks, currency, () => ({
        currency,
        totals: { count: 0, amountMinor: 0 },
        byStatus: [],
        byDay: [],
      }));
    for (const t of totals)
      block(t.currency).totals = { count: t.count, amountMinor: t.amountMinor };
    for (const r of byStatusRaw) {
      block(r.currency).byStatus.push({
        status: r.status,
        count: Number(r.count),
        amountMinor: Number(r.amount),
      });
    }
    for (const r of byDayRaw) {
      block(r.currency).byDay.push({
        day: dayKey(r.day),
        count: Number(r.count),
        amountMinor: Number(r.amount),
      });
    }

    return {
      from,
      to,
      byCurrency: [...blocks.values()].sort(
        (a, b) =>
          b.totals.amountMinor - a.totals.amountMinor || a.currency.localeCompare(b.currency),
      ),
    };
  }

  // ─────────────────────── 5. Platform fees ───────────────────────

  async platformFees(from: Date, to: Date) {
    // Reuse dailyRevenue (which reuses the revenue aggregate) — no new query.
    const daily = await this.dailyRevenue(from, to);
    return {
      from,
      to,
      // Per currency, for the same reason as everything else here: the platform's fee income
      // in rupees and in dollars are two figures, and one of them is not the sum.
      byCurrency: daily.byCurrency.map((c) => ({
        currency: c.currency,
        totals: { platformFeesMinor: c.totals.platformFeesMinor },
        series: c.series.map((s) => ({ day: s.day, feesMinor: s.platformFeesMinor })),
      })),
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
    const revenue = await this.analytics.revenueByCurrency(this.confirmedRange(from, to));

    const lines = await this.prisma.bookingTaxLine.findMany({
      where: { booking: this.confirmedRange(from, to) },
      select: {
        label: true,
        rateBasisPoints: true,
        baseMinor: true,
        amountMinor: true,
        // A tax line is in its booking's currency; GST in rupees and sales tax in dollars are
        // two figures, never one.
        booking: { select: { currency: true } },
      },
    });

    type TaxRow = {
      label: string;
      rateBasisPoints: number;
      baseMinor: number;
      amountMinor: number;
    };
    const blocks = new Map<
      string,
      { byRate: Map<string, TaxRow>; grossMinor: number; platformFeesMinor: number }
    >();
    const block = (currency: string) =>
      blockFor(blocks, currency, () => ({
        byRate: new Map<string, TaxRow>(),
        grossMinor: 0,
        platformFeesMinor: 0,
      }));
    for (const rev of revenue) {
      const b = block(rev.currency);
      b.grossMinor = rev.grossMinor;
      b.platformFeesMinor = rev.bookingFeesMinor + rev.paymentFeesMinor;
    }

    /*
      Grouped by label AND rate, because those are different taxes even under one name.
      Cinema at 5% and a concert at 18% are both "CGST"; summing them into one line would
      hide the split a filing has to state.
    */
    for (const line of lines) {
      const { byRate } = block(line.booking.currency);
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

    const byCurrency = [...blocks.entries()]
      .map(([currency, b]) => {
        const breakdown = [...b.byRate.values()].sort(
          (x, y) => x.label.localeCompare(y.label) || x.rateBasisPoints - y.rateBasisPoints,
        );
        return {
          currency,
          taxCollectedMinor: breakdown.reduce((sum, row) => sum + row.amountMinor, 0),
          /** One row per label+rate, which is the granularity a filing needs. */
          breakdown,
          taxableBaseMinor: b.grossMinor + b.platformFeesMinor,
          grossMinor: b.grossMinor,
          platformFeesMinor: b.platformFeesMinor,
        };
      })
      .sort((x, y) => y.grossMinor - x.grossMinor || x.currency.localeCompare(y.currency));
    const activeRules = await this.prisma.taxRule.count({ where: { active: true } });

    return {
      from,
      to,
      /** Whether any tax rule is configured at all — not whether this period collected any. */
      taxModelled: activeRules > 0,
      byCurrency,
      note:
        activeRules > 0
          ? 'Tax as CHARGED, read from each booking’s snapshot rather than recomputed at ' +
            'today’s rates. This is a record of what was collected — not a return, not a ' +
            'GSTR filing, and not reconciled against a ledger.'
          : 'No tax rule is active, so no tax is being charged. The figures below are the ' +
            'taxable base for reference only.',
    };
  }

  // ─────────────────────── 7. Top experiences ───────────────────────

  async topExperiences(from: Date, to: Date, limit = 10) {
    // Ranked in SQL (group + order + take), then one title lookup — mirrors the
    // topTicketType pattern; no per-event fan-out. Grouped by currency too, so a row's gross is
    // one currency and says which: it was summed across currencies and printed as rupees.
    // The ranking is by booking count, which has no unit.
    const grouped = await this.prisma.booking.groupBy({
      by: ['eventId', 'currency'],
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
          currency: g.currency,
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
    /*
      `currency` is the first column, not a footnote.
      
      A spreadsheet is where a mixed-currency export does the most damage: the first thing
      anyone does with a column of numbers is total it, and nothing in a CSV warns them that
      two of the rows are in a different unit.
    */
    return toCsv(
      [
        'currency',
        'day',
        'grossMinor',
        'platformFeesMinor',
        'refundsMinor',
        'netMinor',
        'bookings',
      ],
      r.byCurrency.flatMap((c) =>
        c.series.map((s) => [
          c.currency,
          s.day,
          s.grossMinor,
          s.platformFeesMinor,
          s.refundsMinor,
          s.netMinor,
          s.bookings,
        ]),
      ),
    );
  }

  async organizerRevenueCsv(from: Date, to: Date, limit?: number): Promise<string> {
    const r = await this.organizerRevenue(from, to, limit);
    // `currency` leads, as in the daily revenue export: a column of mixed units is summed in a
    // spreadsheet the moment it is opened.
    return toCsv(
      [
        'currency',
        'organizationId',
        'organizationName',
        'grossMinor',
        'platformFeesMinor',
        'refundsMinor',
        'netMinor',
        'bookings',
      ],
      r.organizers.map((o) => [
        o.currency,
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
      ['currency', 'day', 'count', 'amountMinor'],
      r.byCurrency.flatMap((c) => c.byDay.map((d) => [c.currency, d.day, d.count, d.amountMinor])),
    );
  }

  async settlementCsv(): Promise<string> {
    const r = await this.settlement();
    return toCsv(
      [
        'currency',
        'organizationId',
        'organizationName',
        'outstandingMinor',
        'outstandingCount',
        'paidMinor',
        'paidCount',
      ],
      r.byCurrency.flatMap((c) =>
        c.byOrg.map((o) => [
          c.currency,
          o.organizationId,
          o.organizationName,
          o.outstandingMinor,
          o.outstandingCount,
          o.paidMinor,
          o.paidCount,
        ]),
      ),
    );
  }
}
