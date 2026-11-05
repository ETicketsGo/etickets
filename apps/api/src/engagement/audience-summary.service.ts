import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Role } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import type { RequestUser } from '../common/decorators';
import { ConsentPurpose } from './consent-purpose';
import {
  AUDIENCE_PRIVACY_THRESHOLD,
  applyPrivacyThreshold,
  withRunningTotal,
  type CityBucket,
} from './audience-privacy';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The organizer's view of their audience: COUNTS ONLY.
 *
 * ── NO FOLLOWER PII ────────────────────────────────────────────────────────────────
 * Nothing here returns a name, an email, a user id or a row per person. A follow is the
 * customer's choice to see an organizer, not permission for the organizer to know who they
 * are. Every number is an aggregate, and the one breakdown that could point at a person (a
 * city) hides any group smaller than `AUDIENCE_PRIVACY_THRESHOLD`.
 *
 * ── TENANCY ────────────────────────────────────────────────────────────────────────
 * Owners and managers of THIS organization only (`assertMember`), and every query is
 * filtered by the organization id it was authorized for. Check-in staff are refused, as
 * they are for every other business figure.
 */
@Injectable()
export class AudienceSummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
  ) {}

  async summary(user: RequestUser, organizationId: string, now = new Date()) {
    await this.access.assertMember(user, organizationId, [
      Role.ORGANIZER_OWNER,
      Role.ORGANIZER_MANAGER,
    ]);
    return this.compute(organizationId, now);
  }

  /** The figures, for an organization the caller has already been authorized for. */
  async compute(organizationId: string, now = new Date()) {
    const since7 = new Date(now.getTime() - 7 * DAY_MS);
    const since30 = new Date(now.getTime() - 30 * DAY_MS);

    const [total, new7, new30, eligible, returning, daily, weekly, cities] = await Promise.all([
      this.prisma.organizerFollow.count({ where: { organizationId } }),
      this.prisma.organizerFollow.count({ where: { organizationId, createdAt: { gte: since7 } } }),
      this.prisma.organizerFollow.count({ where: { organizationId, createdAt: { gte: since30 } } }),
      this.eligibleSubscribers(organizationId),
      this.returningBuyers(organizationId),
      this.series(organizationId, 'day', 30, now),
      this.series(organizationId, 'week', 12, now),
      this.cityBuckets(organizationId),
    ]);

    return {
      organizationId,
      generatedAt: now.toISOString(),
      followers: { total, new7d: new7, new30d: new30 },
      /** Followers who have said yes to this organizer's email and can still receive it. */
      eligibleSubscribers: eligible,
      /** Account holders with two or more confirmed bookings with this organizer. */
      returningBuyers: returning,
      growth: {
        daily: withRunningTotal(daily, total),
        weekly: withRunningTotal(weekly, total),
      },
      cities: applyPrivacyThreshold(cities, AUDIENCE_PRIVACY_THRESHOLD),
    };
  }

  /**
   * Followers whose NEWEST ORGANIZER_UPDATES decision for this organizer is a grant, who have
   * not unsubscribed from it, and whose address is not on the global bounce/complaint list.
   *
   * The consent match uses the account OR the email hash, the same as the service does, so a
   * withdrawal made from a link (which may carry only the address) still counts.
   */
  private async eligibleSubscribers(organizationId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ n: number }[]>(Prisma.sql`
      WITH f AS (
        SELECT f."userId",
               encode(sha256(convert_to('email:' || lower(btrim(u.email)), 'UTF8')), 'hex') AS h
        FROM "OrganizerFollow" f
        JOIN "User" u ON u.id = f."userId"
        WHERE f."organizationId" = ${organizationId}
      ),
      latest AS (
        SELECT DISTINCT ON (f."userId") f."userId", f.h, c.granted
        FROM f
        JOIN "CommunicationConsent" c
          ON c."organizationId" = ${organizationId}
         AND c.purpose = ${ConsentPurpose.ORGANIZER_UPDATES}
         AND c.channel = 'email'
         AND (c."userId" = f."userId" OR c."subjectHash" = f.h)
        ORDER BY f."userId", c."createdAt" DESC, c.id DESC
      )
      SELECT count(*)::int AS n
      FROM latest l
      WHERE l.granted
        AND NOT EXISTS (
          SELECT 1 FROM "OrganizerSuppression" s
          WHERE s."organizationId" = ${organizationId}
            AND s.channel = 'email'
            AND s."destinationHash" = l.h
            AND s."liftedAt" IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM "SuppressedDestination" g
          WHERE g.channel = 'email'
            AND g."destinationHash" = l.h
            AND g."liftedAt" IS NULL
            AND (g."expiresAt" IS NULL OR g."expiresAt" > now())
        )
    `);
    return rows[0]?.n ?? 0;
  }

  /** Guest bookings have no stable person behind them, so only account holders count. */
  private async returningBuyers(organizationId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT count(*)::int AS n FROM (
        SELECT b."userId"
        FROM "Booking" b
        WHERE b."organizationId" = ${organizationId}
          AND b."userId" IS NOT NULL
          AND b.status IN ('CONFIRMED', 'PARTIALLY_REFUNDED')
        GROUP BY b."userId"
        HAVING count(*) >= 2
      ) t
    `);
    return rows[0]?.n ?? 0;
  }

  /** New follows per UTC day or ISO week, oldest first, with empty buckets filled in. */
  private async series(
    organizationId: string,
    unit: 'day' | 'week',
    count: number,
    now: Date,
  ): Promise<{ start: string; newFollowers: number }[]> {
    const step = unit === 'day' ? Prisma.sql`interval '1 day'` : Prisma.sql`interval '1 week'`;
    const unitSql = unit === 'day' ? Prisma.sql`'day'` : Prisma.sql`'week'`;
    const back = count - 1;
    const rows = await this.prisma.$queryRaw<{ start: string; n: number }[]>(Prisma.sql`
      WITH b AS (
        SELECT generate_series(
          date_trunc(${unitSql}, ${now}::timestamptz AT TIME ZONE 'UTC') - (${back}::int * ${step}),
          date_trunc(${unitSql}, ${now}::timestamptz AT TIME ZONE 'UTC'),
          ${step}
        ) AS start
      )
      SELECT to_char(b.start, 'YYYY-MM-DD') AS start, count(f.id)::int AS n
      FROM b
      LEFT JOIN "OrganizerFollow" f
        ON f."organizationId" = ${organizationId}
       AND f."createdAt" >= b.start
       AND f."createdAt" < b.start + ${step}
      GROUP BY b.start
      ORDER BY b.start
    `);
    return rows.map((r) => ({ start: r.start, newFollowers: r.n }));
  }

  /**
   * Followers by the city of the venues they booked with THIS organizer. A follower who booked
   * in two cities counts in both. Only this organization's bookings are read, so nothing here
   * reveals where somebody bought from anyone else.
   */
  private async cityBuckets(organizationId: string): Promise<CityBucket[]> {
    const rows = await this.prisma.$queryRaw<
      { city: string; country: string | null; n: number }[]
    >(Prisma.sql`
      SELECT min(v.city) AS city, v.country, count(DISTINCT b."userId")::int AS n
      FROM "Booking" b
      JOIN "OrganizerFollow" f
        ON f."userId" = b."userId" AND f."organizationId" = ${organizationId}
      JOIN "Event" e ON e.id = b."eventId"
      JOIN "Venue" v ON v.id = e."venueId"
      WHERE b."organizationId" = ${organizationId}
        AND b.status IN ('CONFIRMED', 'PARTIALLY_REFUNDED')
      GROUP BY lower(btrim(v.city)), v.country
    `);
    return rows.map((r) => ({ city: r.city, country: r.country, followers: r.n }));
  }
}
