import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { EntitlementKey, Role } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { EntitlementService } from '../billing/entitlements/entitlement.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';
import { AUDIENCE_PRIVACY_THRESHOLD, applyPrivacyThreshold } from '../engagement/audience-privacy';
import { ORGANIZER_PURPOSES } from '../engagement/consent-purpose';
import { ACCEPTED_RECIPIENT_STATUSES, type RecipientCounts } from './campaign-state';

const MANAGERS = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER];
const DAY_MS = 24 * 3600_000;
const MAX_RANGE_DAYS = 366;
const PAID = Prisma.sql`('CONFIRMED', 'PARTIALLY_REFUNDED')`;
const hashOf = (col: Prisma.Sql) =>
  Prisma.sql`encode(sha256(convert_to('email:' || lower(btrim(${col})), 'UTF8')), 'hex')`;

/** Money in one currency. Never summed across currencies. */
export interface CurrencyAmount {
  currency: string;
  orders: number;
  /** Ticket value: subtotal less discount, in minor units. Fees and tax are not revenue here. */
  ticketRevenueMinor: number;
}

export interface CampaignStats {
  campaignId: string;
  targeted: number;
  eligible: number;
  skippedConsent: number;
  skippedSuppressed: number;
  pending: number;
  accepted: number;
  delivered: number;
  deferred: number;
  bounced: number;
  complained: number;
  failed: number;
  unsubscribed: number;
  uniqueClicks: number;
  /** Unique clicks over delivered, 0..1. Null until something is delivered. */
  clickRate: number | null;
  /**
   * Bookings ATTRIBUTED to the campaign: made by a person who clicked, with this organizer,
   * within the window after their click. Attribution, not cause - they may have booked anyway.
   * Null when the plan does not include sales results.
   */
  attribution: {
    windowDays: number;
    model: 'LAST_CLICK';
    byCurrency: (CurrencyAmount & { revenuePerDeliveredMinor: number | null })[];
  } | null;
  attributionLocked: boolean;
}

/**
 * Audience and campaign analytics for one organizer. Aggregates only, from the real tables.
 *
 * ── RULES ──────────────────────────────────────────────────────────────────────────
 *   - Owners and managers of THIS organization; every query is filtered by its id.
 *   - Money per currency, never added across currencies (INR and USD are not one number).
 *   - Any breakdown that could point at a person (a city, a category) hides groups smaller
 *     than AUDIENCE_PRIVACY_THRESHOLD, exactly like the audience summary.
 *   - No opens: they are not tracked.
 *   - "Attributed", never "caused" or "generated".
 */
@Injectable()
export class CampaignAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly access: OrgAccessService,
    private readonly entitlements: EntitlementService,
  ) {}

  windowDays(override?: number): number {
    const fromConfig = Number(this.config.get<number>('CAMPAIGN_ATTRIBUTION_WINDOW_DAYS') ?? 7);
    const raw = override ?? fromConfig;
    return Number.isInteger(raw) && raw >= 1 && raw <= 30 ? raw : 7;
  }

  private async authorize(user: RequestUser, organizationId: string) {
    await this.access.assertMember(user, organizationId, MANAGERS);
    if (String(this.config.get<string>('CAMPAIGNS_ENABLED') ?? 'false') !== 'true') {
      throw new AppException(
        ErrorCodes.CAMPAIGNS_NOT_ENABLED,
        'Email campaigns are not switched on yet.',
        HttpStatus.FORBIDDEN,
      );
    }
    await this.entitlements.assert(organizationId, EntitlementKey.CAMPAIGNS_ANALYTICS_BASIC);
    return this.entitlements.has(organizationId, EntitlementKey.CAMPAIGNS_ANALYTICS_ADVANCED);
  }

  // ── One campaign ──────────────────────────────────────────────────────────────

  async campaignStats(
    user: RequestUser,
    organizationId: string,
    campaignId: string,
    opts: { windowDays?: number } = {},
  ): Promise<CampaignStats> {
    const advanced = await this.authorize(user, organizationId);
    const c = await this.prisma.campaign.findFirst({
      where: { id: campaignId, organizationId },
      select: { id: true },
    });
    if (!c)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Campaign not found.', HttpStatus.NOT_FOUND);
    return this.statsFor(organizationId, campaignId, advanced, this.windowDays(opts.windowDays));
  }

  /** The figures, for a campaign of an organization the caller is authorized for. */
  async statsFor(
    organizationId: string,
    campaignId: string,
    advanced: boolean,
    windowDays: number,
  ): Promise<CampaignStats> {
    const [groups, delivered, clicks] = await Promise.all([
      this.prisma.campaignRecipient.groupBy({
        by: ['status'],
        where: { campaignId, organizationId },
        _count: { _all: true },
      }),
      this.prisma.campaignRecipient.count({
        where: { campaignId, organizationId, deliveredAt: { not: null } },
      }),
      this.prisma.$queryRaw<{ n: number }[]>`
        SELECT count(DISTINCT "recipientId")::int AS n FROM "CampaignClick" WHERE "campaignId" = ${campaignId}`,
    ]);
    const counts: RecipientCounts = {};
    for (const g of groups) counts[g.status as keyof RecipientCounts] = g._count._all;
    const n = (k: keyof RecipientCounts) => counts[k] ?? 0;
    const targeted = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
    const skipped = n('SKIPPED_CONSENT') + n('SKIPPED_SUPPRESSED');
    const uniqueClicks = clicks[0]?.n ?? 0;
    let attribution: CampaignStats['attribution'] = null;
    if (advanced) {
      const rows = await this.attributed(organizationId, windowDays, campaignId);
      attribution = {
        windowDays,
        model: 'LAST_CLICK',
        byCurrency: rows.map((r) => ({
          currency: r.currency,
          orders: r.orders,
          ticketRevenueMinor: r.ticketRevenueMinor,
          revenuePerDeliveredMinor: delivered ? Math.round(r.ticketRevenueMinor / delivered) : null,
        })),
      };
    }
    return {
      campaignId,
      targeted,
      eligible: targeted - skipped,
      skippedConsent: n('SKIPPED_CONSENT'),
      skippedSuppressed: n('SKIPPED_SUPPRESSED'),
      pending: n('PENDING') + n('QUEUED'),
      accepted: ACCEPTED_RECIPIENT_STATUSES.reduce((sum, s) => sum + n(s), 0),
      delivered,
      deferred: n('DEFERRED'),
      bounced: n('BOUNCED'),
      complained: n('COMPLAINED'),
      failed: n('FAILED'),
      unsubscribed: n('UNSUBSCRIBED'),
      uniqueClicks,
      clickRate: delivered ? uniqueClicks / delivered : null,
      attribution,
      attributionLocked: !advanced,
    };
  }

  /**
   * Attributed bookings, last click wins.
   *
   * For each confirmed booking with this organizer, the campaign clicks by the same person
   * (the account, or the same email hash for a guest checkout) in the `windowDays` before it
   * was confirmed; the LATEST of those clicks gets the booking. So one booking is attributed
   * to one campaign at most, and the per-campaign figures add up to the organizer total.
   * A refunded or cancelled booking is not counted, because the status is read now.
   */
  async attributed(
    organizationId: string,
    windowDays: number,
    campaignId?: string,
    range?: { from: Date; to: Date },
  ): Promise<(CurrencyAmount & { campaignId: string })[]> {
    const window = Prisma.sql`(${windowDays}::int * interval '1 day')`;
    const rows = await this.prisma.$queryRaw<
      { campaignId: string; currency: string; orders: number; revenue: bigint | number }[]
    >(Prisma.sql`
      WITH clicks AS (
        SELECT cc."campaignId", cr."userId", cr."emailHash", min(cc."firstClickedAt") AS at
        FROM "CampaignClick" cc
        JOIN "CampaignRecipient" cr ON cr.id = cc."recipientId"
        WHERE cr."organizationId" = ${organizationId}
        GROUP BY cc."campaignId", cr."userId", cr."emailHash"
      ),
      pairs AS (
        SELECT DISTINCT ON (b.id) b.id, b.currency, (b."subtotalMinor" - b."discountMinor") AS ticket,
               k."campaignId"
        FROM "Booking" b
        JOIN clicks k
          ON (b."userId" = k."userId" OR ${hashOf(Prisma.sql`b."buyerEmail"`)} = k."emailHash")
         AND b."confirmedAt" >= k.at
         AND b."confirmedAt" < k.at + ${window}
        WHERE b."organizationId" = ${organizationId}
          AND b.status IN ${PAID}
          AND b."confirmedAt" IS NOT NULL
          ${range ? Prisma.sql`AND b."confirmedAt" >= ${range.from} AND b."confirmedAt" < ${range.to}` : Prisma.empty}
        ORDER BY b.id, k.at DESC
      )
      SELECT "campaignId", currency, count(*)::int AS orders, COALESCE(sum(ticket), 0)::bigint AS revenue
      FROM pairs
      ${campaignId ? Prisma.sql`WHERE "campaignId" = ${campaignId}` : Prisma.empty}
      GROUP BY "campaignId", currency
      ORDER BY "campaignId", currency
    `);
    return rows.map((r) => ({
      campaignId: r.campaignId,
      currency: r.currency,
      orders: r.orders,
      ticketRevenueMinor: Number(r.revenue),
    }));
  }

  // ── The organizer's audience and campaigns over a range ──────────────────────────

  parseRange(from?: string, to?: string, now = new Date()): { from: Date; to: Date } {
    const end = to ? new Date(to) : now;
    const start = from ? new Date(from) : new Date(end.getTime() - 30 * DAY_MS);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'Choose a valid date range.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * DAY_MS) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'Choose a range of one year or less.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return { from: start, to: end };
  }

  async overview(
    user: RequestUser,
    organizationId: string,
    q: { from?: string; to?: string; windowDays?: number },
  ) {
    const advanced = await this.authorize(user, organizationId);
    const range = this.parseRange(q.from, q.to);
    return this.overviewFor(organizationId, range, advanced, this.windowDays(q.windowDays));
  }

  async overviewFor(
    organizationId: string,
    range: { from: Date; to: Date },
    advanced: boolean,
    windowDays: number,
  ) {
    const days = Math.ceil((range.to.getTime() - range.from.getTime()) / DAY_MS);
    const unit = days > 92 ? 'week' : 'day';
    const [
      followersTotal,
      followersNew,
      bySource,
      subscribers,
      buyers,
      series,
      unsubs,
      cities,
      categories,
      campaigns,
    ] = await Promise.all([
      this.prisma.organizerFollow.count({ where: { organizationId } }),
      this.prisma.organizerFollow.count({
        where: { organizationId, createdAt: { gte: range.from, lt: range.to } },
      }),
      this.prisma.organizerFollow.groupBy({
        by: ['source'],
        where: { organizationId, createdAt: { gte: range.from, lt: range.to } },
        _count: { _all: true },
      }),
      this.subscribers(organizationId),
      this.buyers(organizationId, range),
      this.followSeries(organizationId, range, unit),
      this.unsubscribeSeries(organizationId, range, unit),
      this.cityTrend(organizationId, range),
      this.categoryTrend(organizationId, range),
      this.campaignSummaries(organizationId, range, advanced, windowDays),
    ]);
    const updates = subscribers.find((s) => s.purpose === 'ORGANIZER_UPDATES')?.subscribers ?? 0;
    return {
      organizationId,
      range: { from: range.from.toISOString(), to: range.to.toISOString(), unit },
      threshold: AUDIENCE_PRIVACY_THRESHOLD,
      followers: {
        total: followersTotal,
        newInRange: followersNew,
        /** Where follows came from. Per-event acquisition is not recorded, so it is not shown. */
        bySource: bySource
          .map((s) => ({ source: s.source, followers: s._count._all }))
          .sort((a, b) => b.followers - a.followers),
        series,
      },
      /** People who can get each kind of email from you now: consented and not suppressed. */
      subscribers,
      /** Followers who have also said yes to your event emails. */
      optInRate: followersTotal ? updates / followersTotal : null,
      buyers,
      unsubscribes: unsubs,
      cities,
      categories,
      campaigns,
    };
  }

  /** Current subscribers per purpose: newest consent row granted, and not suppressed. */
  private async subscribers(organizationId: string) {
    const rows = await this.prisma.$queryRaw<{ purpose: string; n: number }[]>(Prisma.sql`
      WITH latest AS (
        SELECT DISTINCT ON (c.purpose, c."subjectHash") c.purpose, c."subjectHash" AS h, c.granted
        FROM "CommunicationConsent" c
        WHERE c."organizationId" = ${organizationId} AND c.channel = 'email'
        ORDER BY c.purpose, c."subjectHash", c."createdAt" DESC, c.id DESC
      )
      SELECT l.purpose, count(*)::int AS n FROM latest l
      WHERE l.granted
        AND NOT EXISTS (SELECT 1 FROM "OrganizerSuppression" s WHERE s."organizationId" = ${organizationId}
          AND s.channel = 'email' AND s."destinationHash" = l.h AND s."liftedAt" IS NULL)
        AND NOT EXISTS (SELECT 1 FROM "SuppressedDestination" g WHERE g.channel = 'email'
          AND g."destinationHash" = l.h AND g."liftedAt" IS NULL
          AND (g."expiresAt" IS NULL OR g."expiresAt" > now()))
      GROUP BY l.purpose
    `);
    return ORGANIZER_PURPOSES.map((purpose) => ({
      purpose,
      subscribers: rows.find((r) => r.purpose === purpose)?.n ?? 0,
    }));
  }

  /** Account holders who bought in the range, and how many of them had bought before too. */
  private async buyers(organizationId: string, range: { from: Date; to: Date }) {
    const rows = await this.prisma.$queryRaw<{ buyers: number; returning: number }[]>(Prisma.sql`
      WITH inrange AS (
        SELECT DISTINCT b."userId" FROM "Booking" b
        WHERE b."organizationId" = ${organizationId} AND b."userId" IS NOT NULL
          AND b.status IN ${PAID} AND b."confirmedAt" >= ${range.from} AND b."confirmedAt" < ${range.to}
      )
      SELECT count(*)::int AS buyers,
        count(*) FILTER (WHERE (
          SELECT count(*) FROM "Booking" b2
          WHERE b2."organizationId" = ${organizationId} AND b2."userId" = inrange."userId"
            AND b2.status IN ${PAID} AND b2."confirmedAt" < ${range.to}
        ) >= 2)::int AS returning
      FROM inrange
    `);
    const r = rows[0] ?? { buyers: 0, returning: 0 };
    return {
      buyers: r.buyers,
      returningCustomers: r.returning,
      repeatBuyerRate: r.buyers ? r.returning / r.buyers : null,
    };
  }

  private async followSeries(
    organizationId: string,
    range: { from: Date; to: Date },
    unit: 'day' | 'week',
  ) {
    return this.series(
      Prisma.sql`SELECT "createdAt" AS at FROM "OrganizerFollow" WHERE "organizationId" = ${organizationId}`,
      range,
      unit,
    );
  }

  /** Unsubscribes from this organizer: new organizer-suppression rows, by bucket. */
  private async unsubscribeSeries(
    organizationId: string,
    range: { from: Date; to: Date },
    unit: 'day' | 'week',
  ) {
    const series = await this.series(
      Prisma.sql`SELECT "createdAt" AS at FROM "OrganizerSuppression" WHERE "organizationId" = ${organizationId} AND channel = 'email'`,
      range,
      unit,
    );
    return { total: series.reduce((a, p) => a + p.count, 0), series };
  }

  private async series(
    source: Prisma.Sql,
    range: { from: Date; to: Date },
    unit: 'day' | 'week',
  ): Promise<{ start: string; count: number }[]> {
    const step = unit === 'day' ? Prisma.sql`interval '1 day'` : Prisma.sql`interval '1 week'`;
    const unitSql = unit === 'day' ? Prisma.sql`'day'` : Prisma.sql`'week'`;
    const rows = await this.prisma.$queryRaw<{ start: string; n: number }[]>(Prisma.sql`
      WITH b AS (
        SELECT generate_series(
          date_trunc(${unitSql}, ${range.from}::timestamptz AT TIME ZONE 'UTC'),
          date_trunc(${unitSql}, ${range.to}::timestamptz AT TIME ZONE 'UTC'),
          ${step}
        ) AS start
      ),
      src AS (${source})
      SELECT to_char(b.start, 'YYYY-MM-DD') AS start, count(src.at)::int AS n
      FROM b LEFT JOIN src ON src.at >= b.start AND src.at < b.start + ${step}
        AND src.at >= ${range.from} AND src.at < ${range.to}
      GROUP BY b.start ORDER BY b.start
    `);
    return rows.map((r) => ({ start: r.start, count: r.n }));
  }

  /** Distinct buyers by venue city in the range. Small groups hidden. */
  private async cityTrend(organizationId: string, range: { from: Date; to: Date }) {
    const rows = await this.prisma.$queryRaw<
      { city: string; country: string | null; n: number }[]
    >(Prisma.sql`
      SELECT min(v.city) AS city, v.country,
        count(DISTINCT COALESCE(b."userId", ${hashOf(Prisma.sql`b."buyerEmail"`)}))::int AS n
      FROM "Booking" b JOIN "Event" e ON e.id = b."eventId" JOIN "Venue" v ON v.id = e."venueId"
      WHERE b."organizationId" = ${organizationId} AND b.status IN ${PAID}
        AND b."confirmedAt" >= ${range.from} AND b."confirmedAt" < ${range.to}
      GROUP BY lower(btrim(v.city)), v.country
    `);
    const t = applyPrivacyThreshold(
      rows.map((r) => ({ city: r.city, country: r.country, followers: r.n })),
    );
    return {
      buckets: t.buckets.map((b) => ({ city: b.city, country: b.country, buyers: b.followers })),
      hiddenBuckets: t.hiddenBuckets,
      threshold: t.threshold,
    };
  }

  /** Distinct buyers by event category in the range. Small groups hidden. */
  private async categoryTrend(organizationId: string, range: { from: Date; to: Date }) {
    const rows = await this.prisma.$queryRaw<{ category: string; n: number }[]>(Prisma.sql`
      SELECT e.category, count(DISTINCT COALESCE(b."userId", ${hashOf(Prisma.sql`b."buyerEmail"`)}))::int AS n
      FROM "Booking" b JOIN "Event" e ON e.id = b."eventId"
      WHERE b."organizationId" = ${organizationId} AND b.status IN ${PAID}
        AND b."confirmedAt" >= ${range.from} AND b."confirmedAt" < ${range.to}
      GROUP BY e.category
    `);
    const shown = rows
      .filter((r) => r.n >= AUDIENCE_PRIVACY_THRESHOLD)
      .sort((a, b) => b.n - a.n)
      .map((r) => ({ category: r.category, buyers: r.n }));
    return {
      buckets: shown,
      hiddenBuckets: rows.length - shown.length,
      threshold: AUDIENCE_PRIVACY_THRESHOLD,
    };
  }

  /** Campaigns created in the range, with their headline numbers. */
  private async campaignSummaries(
    organizationId: string,
    range: { from: Date; to: Date },
    advanced: boolean,
    windowDays: number,
  ) {
    const campaigns = await this.prisma.campaign.findMany({
      where: { organizationId, createdAt: { gte: range.from, lt: range.to } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        name: true,
        status: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
      },
    });
    const out = [];
    for (const c of campaigns) {
      const s = await this.statsFor(organizationId, c.id, advanced, windowDays);
      out.push({
        id: c.id,
        name: c.name,
        status: c.status,
        startedAt: c.startedAt?.toISOString() ?? null,
        targeted: s.targeted,
        delivered: s.delivered,
        bounced: s.bounced,
        complained: s.complained,
        unsubscribed: s.unsubscribed,
        uniqueClicks: s.uniqueClicks,
        clickRate: s.clickRate,
        attributed: s.attribution?.byCurrency ?? null,
      });
    }
    return { items: out, attributionLocked: !advanced, windowDays };
  }

  /** CSV of the AGGREGATES above. Never a row per person. */
  async exportCsv(
    user: RequestUser,
    organizationId: string,
    q: { from?: string; to?: string; windowDays?: number },
  ): Promise<string> {
    const o = await this.overview(user, organizationId, q);
    const lines: string[][] = [['section', 'key', 'value', 'currency']];
    lines.push(['range', 'from', o.range.from, ''], ['range', 'to', o.range.to, '']);
    lines.push(['followers', 'total', String(o.followers.total), '']);
    lines.push(['followers', 'new_in_range', String(o.followers.newInRange), '']);
    for (const s of o.followers.bySource)
      lines.push(['followers_by_source', s.source, String(s.followers), '']);
    for (const s of o.subscribers)
      lines.push(['subscribers', s.purpose, String(s.subscribers), '']);
    lines.push(['buyers', 'buyers_in_range', String(o.buyers.buyers), '']);
    lines.push(['buyers', 'returning_customers', String(o.buyers.returningCustomers), '']);
    lines.push(['unsubscribes', 'total_in_range', String(o.unsubscribes.total), '']);
    for (const c of o.cities.buckets) lines.push(['buyers_by_city', c.city, String(c.buyers), '']);
    for (const c of o.categories.buckets)
      lines.push(['buyers_by_category', c.category, String(c.buyers), '']);
    for (const c of o.campaigns.items) {
      const k = `${c.name} [${c.id}]`;
      lines.push(['campaign_targeted', k, String(c.targeted), '']);
      lines.push(['campaign_delivered', k, String(c.delivered), '']);
      lines.push(['campaign_unique_clicks', k, String(c.uniqueClicks), '']);
      lines.push(['campaign_unsubscribed', k, String(c.unsubscribed), '']);
      for (const a of c.attributed ?? []) {
        lines.push(['campaign_attributed_orders', k, String(a.orders), a.currency]);
        lines.push([
          'campaign_attributed_ticket_revenue_minor',
          k,
          String(a.ticketRevenueMinor),
          a.currency,
        ]);
      }
    }
    return lines.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }
}

/** One CSV cell, quoted, with formula injection neutralised (a cell starting = + - @). */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}
