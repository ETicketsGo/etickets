import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CostSource, OutcomeClass, microsToDecimalString } from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';

export interface AnalyticsWindow {
  from: Date;
  to: Date;
  provider?: string;
  channel?: string;
  eventType?: string;
  country?: string;
  organizationId?: string;
}

/** A total is only meaningful next to how much of it is missing. */
export interface CostTotal {
  currency: string;
  costMicro: number;
  cost: string;
  attempts: number;
}

/**
 * What the platform spent on messages, and how much of that it can actually account for.
 *
 * ── WHY EVERY AGGREGATION IS SQL ───────────────────────────────────────────────────
 * A month of notifications is millions of delivery rows. Pulling them into Node to sum them
 * is not slow, it is an outage: the process holds the lot in memory, the event loop stops,
 * and the endpoint that was meant to answer a finance question takes the API down with it.
 * Every number below is produced by `groupBy` or a raw aggregate against the indexes declared
 * on the model, and nothing larger than the result set is ever materialised.
 *
 * ── WHY UNKNOWN TRAVELS WITH EVERY TOTAL ───────────────────────────────────────────
 * A cost report where unpriced attempts silently contribute zero is a floor presented as an
 * answer, and the reader has no way to tell. So `unknownAttempts` is beside every figure: it
 * is the number of sends this platform genuinely cannot price, and until it is zero the total
 * is a lower bound rather than a cost.
 *
 * ── WHY CURRENCIES ARE NEVER ADDED ─────────────────────────────────────────────────
 * There is no exchange rate in this file and there will not be one. Rupees and dollars are
 * returned as separate rows; inventing a conversion to produce one comforting number would
 * make the report wrong at a rate that changes daily and in a direction nobody chose.
 */
@Injectable()
export class NotificationAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The delivery-side filter, shared by every Prisma-based report so they cannot drift apart.
   *
   * Tenant is NOT here. `Notification.bookingId` deliberately carries no foreign key — an
   * accounting column must not be able to stop a message being sent — so there is no relation
   * for Prisma to filter through. Every report that supports a tenant filter joins to Booking
   * in SQL instead, which is where that work belongs anyway.
   */
  private where(w: AnalyticsWindow): Prisma.NotificationDeliveryWhereInput {
    return {
      createdAt: { gte: w.from, lte: w.to },
      ...(w.provider ? { provider: w.provider } : {}),
      ...(w.channel ? { channel: w.channel } : {}),
      ...(w.eventType ? { notification: { type: w.eventType as never } } : {}),
    };
  }

  /** `AND b."organizationId" = …`, or nothing. Kept in one place so it cannot drift. */
  private tenantClause(w: AnalyticsWindow): Prisma.Sql {
    return w.organizationId
      ? Prisma.sql`AND b."organizationId" = ${w.organizationId}`
      : Prisma.empty;
  }

  private providerClause(w: AnalyticsWindow): Prisma.Sql {
    return w.provider ? Prisma.sql`AND d."provider" = ${w.provider}` : Prisma.empty;
  }

  private channelClause(w: AnalyticsWindow): Prisma.Sql {
    return w.channel ? Prisma.sql`AND d."channel" = ${w.channel}` : Prisma.empty;
  }

  private eventClause(w: AnalyticsWindow): Prisma.Sql {
    return w.eventType
      ? Prisma.sql`AND n."type" = ${w.eventType}::"NotificationType"`
      : Prisma.empty;
  }

  /**
   * Headline counts and cost, per currency.
   *
   * Reports two different numbers on purpose. `attempts` is what providers were asked to do;
   * `notifications` is how many messages a customer would say they received. A retry, a
   * fallback and an operator resend all raise the first and not the second, which is exactly
   * the gap worth watching.
   */
  async summary(w: AnalyticsWindow) {
    const scope = Prisma.sql`
      FROM "NotificationDelivery" d
      JOIN "Notification" n ON n."id" = d."notificationId"
      LEFT JOIN "Booking" b ON b."id" = n."bookingId"
      WHERE d."createdAt" >= ${w.from} AND d."createdAt" <= ${w.to}
        ${this.providerClause(w)} ${this.channelClause(w)}
        ${this.eventClause(w)} ${this.tenantClause(w)}
    `;

    const [byOutcome, byKind, costs, unknown, notifications] = await Promise.all([
      this.prisma.$queryRaw<{ outcome: string | null; n: bigint }[]>`
        SELECT d."outcomeClass" AS outcome, COUNT(*)::bigint AS n ${scope}
        GROUP BY d."outcomeClass"`,
      this.prisma.$queryRaw<{ kind: string; n: bigint }[]>`
        SELECT d."sendKind" AS kind, COUNT(*)::bigint AS n ${scope}
        GROUP BY d."sendKind"`,
      this.prisma.$queryRaw<{ currency: string | null; cost: bigint | null; n: bigint }[]>`
        SELECT d."costCurrency" AS currency, SUM(d."costMicro")::bigint AS cost,
               COUNT(*)::bigint AS n ${scope} AND d."costMicro" IS NOT NULL
        GROUP BY d."costCurrency"`,
      this.prisma.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(*)::bigint AS n ${scope} AND d."costSource" = 'UNKNOWN'`,
      /*
        Logical notifications, counted separately from attempts. A retry, a fallback and an
        operator resend all raise the attempt count and not this one -- which is the gap
        worth watching, and is invisible if only one number is reported.
      */
      this.prisma.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(*)::bigint AS n
        FROM "Notification" n
        LEFT JOIN "Booking" b ON b."id" = n."bookingId"
        WHERE n."createdAt" >= ${w.from} AND n."createdAt" <= ${w.to}
          ${w.channel ? Prisma.sql`AND n."channel" = ${w.channel}` : Prisma.empty}
          ${this.eventClause(w)} ${this.tenantClause(w)}`,
    ]);

    const outcomes = Object.fromEntries(
      byOutcome.map((r) => [r.outcome ?? 'UNCLASSIFIED', Number(r.n)]),
    );

    return {
      window: { from: w.from, to: w.to },
      /** How many messages the platform decided to send. */
      notifications: Number(notifications[0]?.n ?? 0),
      /** How many times a provider was asked to carry one. Always >= notifications. */
      attempts: byOutcome.reduce((sum, r) => sum + Number(r.n), 0),
      outcomes,
      accepted: outcomes[OutcomeClass.PROVIDER_ACCEPTED] ?? 0,
      suppressed: outcomes[OutcomeClass.POLICY_SUPPRESSED] ?? 0,
      noDestination: outcomes[OutcomeClass.NO_DESTINATION] ?? 0,
      byKind: Object.fromEntries(byKind.map((r) => [r.kind, Number(r.n)])),
      cost: costs.map((r) => ({
        currency: r.currency ?? 'UNKNOWN',
        costMicro: Number(r.cost ?? 0),
        cost: microsToDecimalString(Number(r.cost ?? 0)),
        attempts: Number(r.n),
      })),
      /*
        The honesty column. Until this is zero, `cost` is a floor and not an answer, and a
        reader who cannot see it has no way of knowing that.
      */
      unknownCostAttempts: Number(unknown[0]?.n ?? 0),
    };
  }

  /** Cost broken down by whichever dimension somebody is asking about. */
  async costs(w: AnalyticsWindow, by: 'provider' | 'channel' | 'sendKind') {
    const where = this.where(w);
    const grouped = await this.prisma.notificationDelivery.groupBy({
      by: [by, 'costCurrency'],
      where: { ...where, costMicro: { not: null } },
      _sum: { costMicro: true },
      _count: { _all: true },
    });
    const unknown = await this.prisma.notificationDelivery.groupBy({
      by: [by],
      where: { ...where, costSource: CostSource.UNKNOWN },
      _count: { _all: true },
    });
    const unknownBy = new Map(
      unknown.map((r) => [String((r as Record<string, unknown>)[by]), r._count._all]),
    );

    const keys = [
      ...new Set(grouped.map((r) => String((r as Record<string, unknown>)[by]))),
      ...unknownBy.keys(),
    ];
    return [...new Set(keys)].map((key) => ({
      [by]: key,
      totals: this.toTotals(
        grouped.filter((r) => String((r as Record<string, unknown>)[by]) === key),
      ),
      unknownCostAttempts: unknownBy.get(key) ?? 0,
    }));
  }

  /**
   * Cost by the market a message was delivered INTO.
   *
   * ── WHY THIS IS A RAW QUERY ────────────────────────────────────────────────────────
   * There is no country column on a delivery, and adding one would duplicate a fact that is
   * already derivable — the venue's country, through the booking. So this joins, in SQL,
   * where the database can use its indexes. The alternative is loading a month of deliveries
   * and grouping them in Node, which is the thing this whole service exists to avoid.
   *
   * Notifications with no booking have no market and are reported as `null` rather than
   * dropped: how much of the spend cannot be attributed to a market is itself a finding.
   */
  async byCountry(w: AnalyticsWindow) {
    const rows = await this.prisma.$queryRaw<
      { country: string | null; currency: string | null; cost: bigint | null; attempts: bigint }[]
    >`
      SELECT v."country" AS country,
             d."costCurrency" AS currency,
             SUM(d."costMicro")::bigint AS cost,
             COUNT(*)::bigint AS attempts
      FROM "NotificationDelivery" d
      JOIN "Notification" n ON n."id" = d."notificationId"
      LEFT JOIN "Booking" b ON b."id" = n."bookingId"
      LEFT JOIN "Event" e ON e."id" = b."eventId"
      LEFT JOIN "Venue" v ON v."id" = e."venueId"
      WHERE d."createdAt" >= ${w.from} AND d."createdAt" <= ${w.to}
        AND d."costMicro" IS NOT NULL
        ${this.providerClause(w)} ${this.channelClause(w)} ${this.tenantClause(w)}
      GROUP BY v."country", d."costCurrency"
      ORDER BY cost DESC NULLS LAST
    `;
    return rows.map((r) => ({
      country: r.country,
      currency: r.currency,
      costMicro: Number(r.cost ?? 0),
      cost: microsToDecimalString(Number(r.cost ?? 0)),
      attempts: Number(r.attempts),
    }));
  }

  /** Which kinds of message cost the most. The question that drives fee-setting. */
  async byEvent(w: AnalyticsWindow) {
    const rows = await this.prisma.$queryRaw<
      {
        type: string;
        send_kind: string;
        currency: string | null;
        cost: bigint | null;
        attempts: bigint;
        unknown_attempts: bigint;
      }[]
    >`
      SELECT n."type"::text AS type,
             d."sendKind" AS send_kind,
             d."costCurrency" AS currency,
             SUM(d."costMicro")::bigint AS cost,
             COUNT(*)::bigint AS attempts,
             COUNT(*) FILTER (WHERE d."costSource" = 'UNKNOWN')::bigint AS unknown_attempts
      FROM "NotificationDelivery" d
      JOIN "Notification" n ON n."id" = d."notificationId"
      LEFT JOIN "Booking" b ON b."id" = n."bookingId"
      WHERE d."createdAt" >= ${w.from} AND d."createdAt" <= ${w.to}
        ${this.providerClause(w)} ${this.channelClause(w)} ${this.tenantClause(w)}
      GROUP BY n."type", d."sendKind", d."costCurrency"
      ORDER BY cost DESC NULLS LAST
    `;
    return rows.map((r) => ({
      eventType: r.type,
      // PRIMARY | RETRY | FALLBACK | MANUAL_RESEND. A fallback SMS on a cancellation and an
      // ordinary confirmation email are both "notification cost" and nothing else about them
      // is alike.
      sendKind: r.send_kind,
      currency: r.currency,
      costMicro: Number(r.cost ?? 0),
      cost: microsToDecimalString(Number(r.cost ?? 0)),
      attempts: Number(r.attempts),
      unknownCostAttempts: Number(r.unknown_attempts),
    }));
  }

  /**
   * What notifications cost per booking.
   *
   * Only counts messages actually LINKED to a booking, and separately reports how many are
   * not: an organizer payout notice and a password reset are real spend that no booking
   * should carry, and folding them in would overstate the per-booking figure by however much
   * unrelated traffic the platform happens to send.
   */
  async costPerBooking(w: AnalyticsWindow) {
    const rows = await this.prisma.$queryRaw<
      { currency: string | null; cost: bigint | null; bookings: bigint; attempts: bigint }[]
    >`
      SELECT d."costCurrency" AS currency,
             SUM(d."costMicro")::bigint AS cost,
             COUNT(DISTINCT n."bookingId")::bigint AS bookings,
             COUNT(*)::bigint AS attempts
      FROM "NotificationDelivery" d
      JOIN "Notification" n ON n."id" = d."notificationId"
      LEFT JOIN "Booking" b ON b."id" = n."bookingId"
      WHERE d."createdAt" >= ${w.from} AND d."createdAt" <= ${w.to}
        AND n."bookingId" IS NOT NULL
        AND d."costMicro" IS NOT NULL
        ${this.providerClause(w)} ${this.channelClause(w)} ${this.tenantClause(w)}
      GROUP BY d."costCurrency"
    `;

    const [unlinked, unlinkedUnknown] = await Promise.all([
      this.prisma.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(*)::bigint AS n
        FROM "NotificationDelivery" d
        JOIN "Notification" n ON n."id" = d."notificationId"
        WHERE d."createdAt" >= ${w.from} AND d."createdAt" <= ${w.to}
          AND n."bookingId" IS NULL AND d."costMicro" IS NOT NULL`,
      this.prisma.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(*)::bigint AS n
        FROM "NotificationDelivery" d
        JOIN "Notification" n ON n."id" = d."notificationId"
        WHERE d."createdAt" >= ${w.from} AND d."createdAt" <= ${w.to}
          AND n."bookingId" IS NULL AND d."costSource" = 'UNKNOWN'`,
    ]);

    return {
      perCurrency: rows.map((r) => {
        const cost = Number(r.cost ?? 0);
        const bookings = Number(r.bookings);
        return {
          currency: r.currency,
          costMicro: cost,
          cost: microsToDecimalString(cost),
          bookings,
          attempts: Number(r.attempts),
          // Integer division in micros, so the average is exact to a millionth rather than
          // a float that drifts on the sixth decimal place.
          averagePerBookingMicro: bookings > 0 ? Math.round(cost / bookings) : null,
          averagePerBooking:
            bookings > 0 ? microsToDecimalString(Math.round(cost / bookings)) : null,
        };
      }),
      /** Spend that belongs to no booking, so nobody mistakes the average for the total. */
      unlinkedAttempts: Number(unlinked[0]?.n ?? 0),
      unlinkedUnknownCostAttempts: Number(unlinkedUnknown[0]?.n ?? 0),
    };
  }

  /**
   * How each provider is actually doing, with a denominator that is only about them.
   *
   * ── THE DENOMINATOR IS THE WHOLE POINT ─────────────────────────────────────────────
   * A suppressed address, somebody with no phone number, a channel a customer switched off:
   * none of these say anything about a provider, and including them makes every provider look
   * broken in proportion to how many of our customers have preferences. Worse, it hides a
   * real outage inside a number that is always high. So the rate below is computed only over
   * outcomes the provider is responsible for.
   *
   * Push has no delivery rate and never will — FCM and Web Push have no per-message callback
   * — so `deliveryMeasurable` says whether the delivery figure means anything, rather than
   * quietly reporting 0% for the channel that works best.
   */
  async providerHealth(w: AnalyticsWindow) {
    const grouped = await this.prisma.notificationDelivery.groupBy({
      by: ['provider', 'channel', 'outcomeClass'],
      where: { ...this.where(w), provider: { not: 'none' } },
      _count: { _all: true },
    });

    const delivered = await this.prisma.notificationDelivery.groupBy({
      by: ['provider', 'channel'],
      where: { ...this.where(w), deliveredAt: { not: null } },
      _count: { _all: true },
    });
    const deliveredBy = new Map(
      delivered.map((r) => [`${r.provider}:${r.channel}`, r._count._all]),
    );

    const byKey = new Map<
      string,
      { provider: string; channel: string; outcomes: Record<string, number> }
    >();
    for (const g of grouped) {
      const key = `${g.provider}:${g.channel}`;
      const entry = byKey.get(key) ?? { provider: g.provider, channel: g.channel, outcomes: {} };
      entry.outcomes[g.outcomeClass ?? 'UNCLASSIFIED'] = g._count._all;
      byKey.set(key, entry);
    }

    return [...byKey.values()].map((e) => {
      const accepted = e.outcomes[OutcomeClass.PROVIDER_ACCEPTED] ?? 0;
      const rejected = e.outcomes[OutcomeClass.PROVIDER_REJECTED] ?? 0;
      const unavailable = e.outcomes[OutcomeClass.PROVIDER_UNAVAILABLE] ?? 0;
      const undeliverable = e.outcomes[OutcomeClass.UNDELIVERABLE_DESTINATION] ?? 0;
      // Only outcomes the provider owns. Suppression and missing destinations never reach
      // here: their attempts carry provider `none` and are filtered out above.
      const providerAttempts = accepted + rejected + unavailable + undeliverable;

      return {
        provider: e.provider,
        channel: e.channel,
        providerAttempts,
        outcomes: e.outcomes,
        acceptedRate: providerAttempts > 0 ? round(accepted / providerAttempts) : null,
        providerRejectionRate: providerAttempts > 0 ? round(rejected / providerAttempts) : null,
        providerUnavailableRate:
          providerAttempts > 0 ? round(unavailable / providerAttempts) : null,
        undeliverableRate: providerAttempts > 0 ? round(undeliverable / providerAttempts) : null,
        /*
          Push cannot report delivery, so a delivery rate for it would be a fabricated 0%.
          Saying the measurement does not exist is the only truthful option.
        */
        deliveryMeasurable: e.channel !== 'push' && e.channel !== 'in_app',
        deliveredCount: deliveredBy.get(`${e.provider}:${e.channel}`) ?? 0,
      };
    });
  }

  /** Group a per-currency aggregate into totals, never adding two currencies together. */
  private toTotals(
    rows: {
      costCurrency: string | null;
      _sum: { costMicro: number | null };
      _count: { _all: number };
    }[],
  ): CostTotal[] {
    return rows
      .filter((r) => r.costCurrency)
      .map((r) => ({
        currency: r.costCurrency as string,
        costMicro: r._sum.costMicro ?? 0,
        cost: microsToDecimalString(r._sum.costMicro ?? 0),
        attempts: r._count._all,
      }));
  }
}

const round = (n: number) => Number(n.toFixed(4));
