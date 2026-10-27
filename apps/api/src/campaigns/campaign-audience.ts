import { Prisma } from '@prisma/client';
import { z } from 'zod';

/**
 * Who a campaign is for: a DEFINITION, turned into people only inside the database.
 *
 * ── THE RULES THIS FILE EXISTS TO HOLD ─────────────────────────────────────────────
 *   1. Tenant-scoped. Every source reads only rows of the organization the caller was
 *      authorized for. An event id from another organizer matches nobody.
 *   2. Consent-enforced. A source only says who MIGHT get the email. Each person is then
 *      classified by their CURRENT consent for exactly this organizer and the campaign's
 *      purpose (the newest row wins, no row is no), and by both suppression lists. A ticket
 *      purchase alone never makes anybody eligible - there is no source that skips consent.
 *   3. No PII leaves the database for the organizer. The preview returns counts. The
 *      materialisation copies addresses from one table to another inside one SQL statement,
 *      so the API process never even holds a list.
 *
 * The SQL here and in `AudienceSummaryService.eligibleSubscribers` (#502) use the same hash
 * (`SuppressionService.hash('email', ...)` = sha256 of "email:" + lower(trim(address))) and
 * the same newest-row-wins rule.
 */

export const AUDIENCE_SOURCES = [
  'FOLLOWERS',
  'REPEAT_BUYERS',
  'EARLY_ACCESS',
  'EVENT_BUYERS',
] as const;
export type AudienceSource = (typeof AUDIENCE_SOURCES)[number];

export const audienceSchema = z
  .object({
    /** Who might get it. Several sources are a union. */
    sources: z.array(z.enum(AUDIENCE_SOURCES)).min(1).max(AUDIENCE_SOURCES.length),
    /** For EVENT_BUYERS: which of this organizer's events. */
    eventIds: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
    /** Keep only people who booked with this organizer at a venue in one of these cities. */
    cities: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
    /** Use a saved segment's definition instead of the fields above. */
    savedSegmentId: z.string().trim().min(1).max(64).optional(),
  })
  .strict()
  .refine((a) => !a.sources.includes('EVENT_BUYERS') || (a.eventIds?.length ?? 0) > 0, {
    message: 'Choose at least one event for "People who booked an event".',
    path: ['eventIds'],
  });
export type AudienceDefinition = z.infer<typeof audienceSchema>;

/** A saved segment holds the same shape, without pointing at another segment. */
export const segmentDefinitionSchema = z
  .object({
    sources: z.array(z.enum(AUDIENCE_SOURCES)).min(1).max(AUDIENCE_SOURCES.length),
    eventIds: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
    cities: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  })
  .strict();
export type SegmentDefinition = z.infer<typeof segmentDefinitionSchema>;

/** Whether a definition uses the parts that need `audience.advanced`. */
export function usesAdvancedAudience(def: AudienceDefinition | SegmentDefinition): boolean {
  return (
    (def.cities?.length ?? 0) > 0 ||
    ('savedSegmentId' in def && !!(def as AudienceDefinition).savedSegmentId)
  );
}

const PAID = Prisma.sql`('CONFIRMED', 'PARTIALLY_REFUNDED')`;

/** sha256('email:' + lower(trim(x))) in hex - `SuppressionService.hash('email', x)`. */
function hashOf(column: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`encode(sha256(convert_to('email:' || lower(btrim(${column})), 'UTF8')), 'hex')`;
}

/**
 * The CTE chain that ends in `classified`: one row per distinct email hash with
 *   h, "userId", email, granted (current consent for the purpose), org_suppressed,
 *   global_suppressed.
 * Callers append their own SELECT.
 */
export function classifiedAudienceSql(
  organizationId: string,
  purpose: string,
  def: SegmentDefinition,
): Prisma.Sql {
  const sources = new Set(def.sources);
  const parts: Prisma.Sql[] = [];
  if (sources.has('FOLLOWERS')) {
    parts.push(Prisma.sql`
      SELECT u.id AS "userId", u.email AS email
      FROM "OrganizerFollow" f JOIN "User" u ON u.id = f."userId"
      WHERE f."organizationId" = ${organizationId} AND u.status = 'ACTIVE'`);
  }
  if (sources.has('REPEAT_BUYERS')) {
    parts.push(Prisma.sql`
      SELECT u.id AS "userId", u.email AS email
      FROM (
        SELECT b."userId" FROM "Booking" b
        WHERE b."organizationId" = ${organizationId} AND b."userId" IS NOT NULL
          AND b.status IN ${PAID}
        GROUP BY b."userId" HAVING count(*) >= 2
      ) r JOIN "User" u ON u.id = r."userId"
      WHERE u.status = 'ACTIVE'`);
  }
  if (sources.has('EARLY_ACCESS')) {
    parts.push(Prisma.sql`
      SELECT u.id AS "userId", u.email AS email
      FROM (
        SELECT DISTINCT ON (c."userId") c."userId", c.granted
        FROM "CommunicationConsent" c
        WHERE c."organizationId" = ${organizationId} AND c.purpose = 'EARLY_ACCESS'
          AND c.channel = 'email' AND c."userId" IS NOT NULL
        ORDER BY c."userId", c."createdAt" DESC, c.id DESC
      ) e JOIN "User" u ON u.id = e."userId"
      WHERE e.granted AND u.status = 'ACTIVE'`);
  }
  if (sources.has('EVENT_BUYERS') && def.eventIds?.length) {
    parts.push(Prisma.sql`
      SELECT b."userId" AS "userId", COALESCE(u.email, b."buyerEmail") AS email
      FROM "Booking" b LEFT JOIN "User" u ON u.id = b."userId"
      WHERE b."organizationId" = ${organizationId}
        AND b."eventId" IN (${Prisma.join(def.eventIds)})
        AND b.status IN ${PAID}
        AND (u.id IS NULL OR u.status = 'ACTIVE')`);
  }
  if (parts.length === 0) {
    parts.push(Prisma.sql`SELECT NULL::text AS "userId", NULL::text AS email WHERE false`);
  }
  const cities = (def.cities ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean);
  const cityFilter = cities.length
    ? Prisma.sql`WHERE EXISTS (
        SELECT 1 FROM "Booking" b
        JOIN "Event" e ON e.id = b."eventId"
        JOIN "Venue" v ON v.id = e."venueId"
        WHERE b."organizationId" = ${organizationId}
          AND b.status IN ${PAID}
          AND (b."userId" = p."userId" OR ${hashOf(Prisma.sql`b."buyerEmail"`)} = p.h)
          AND lower(btrim(v.city)) IN (${Prisma.join(cities)})
      )`
    : Prisma.empty;

  return Prisma.sql`
    WITH cand AS (${Prisma.join(parts, ' UNION ALL ')}),
    hashed AS (
      SELECT "userId", btrim(email) AS email, ${hashOf(Prisma.sql`email`)} AS h
      FROM cand WHERE email IS NOT NULL AND position('@' in email) > 1
    ),
    people AS (
      SELECT DISTINCT ON (h) h, "userId", email FROM hashed ORDER BY h, "userId" NULLS LAST
    ),
    filtered AS (SELECT p.* FROM people p ${cityFilter}),
    classified AS (
      SELECT f.h, f."userId", f.email,
        COALESCE((
          SELECT c.granted FROM "CommunicationConsent" c
          WHERE c."organizationId" = ${organizationId} AND c.purpose = ${purpose}
            AND c.channel = 'email'
            AND (c."userId" = f."userId" OR c."subjectHash" = f.h)
          ORDER BY c."createdAt" DESC, c.id DESC LIMIT 1
        ), false) AS granted,
        EXISTS (
          SELECT 1 FROM "OrganizerSuppression" s
          WHERE s."organizationId" = ${organizationId} AND s.channel = 'email'
            AND s."destinationHash" = f.h AND s."liftedAt" IS NULL
        ) AS org_suppressed,
        EXISTS (
          SELECT 1 FROM "SuppressedDestination" g
          WHERE g.channel = 'email' AND g."destinationHash" = f.h AND g."liftedAt" IS NULL
            AND (g."expiresAt" IS NULL OR g."expiresAt" > now())
        ) AS global_suppressed
      FROM filtered f
    )`;
}

export interface AudienceCounts {
  /** Distinct people the definition matched. */
  matched: number;
  /** Consented, not suppressed: the people who would get it. */
  eligible: number;
  /** Matched but no current consent for this organizer and purpose. */
  noConsent: number;
  /** Consented, but the address bounced or complained (platform-wide list). */
  suppressedGlobal: number;
  /** Consented, but unsubscribed from this organizer. */
  suppressedOrganizer: number;
}

/** Counts only. The order of the CASE is the order a person is reported in. */
export function audienceCountsSql(
  organizationId: string,
  purpose: string,
  def: SegmentDefinition,
): Prisma.Sql {
  return Prisma.sql`${classifiedAudienceSql(organizationId, purpose, def)}
    SELECT
      count(*)::int AS matched,
      count(*) FILTER (WHERE granted AND NOT org_suppressed AND NOT global_suppressed)::int AS eligible,
      count(*) FILTER (WHERE NOT granted)::int AS "noConsent",
      count(*) FILTER (WHERE granted AND global_suppressed)::int AS "suppressedGlobal",
      count(*) FILTER (WHERE granted AND org_suppressed AND NOT global_suppressed)::int AS "suppressedOrganizer"
    FROM classified`;
}

/**
 * Materialise one batch of recipients, keyset-paged by hash. Idempotent: the unique
 * (campaignId, emailHash) index makes a rerun insert nothing it inserted before.
 *
 * Only an ELIGIBLE row keeps its address (it still has to be sent to). A skipped row keeps the
 * hash and a mask, so the stats can say "skipped" without holding anybody's email.
 */
export function materialiseBatchSql(input: {
  campaignId: string;
  organizationId: string;
  purpose: string;
  def: SegmentDefinition;
  afterHash: string;
  limit: number;
}): Prisma.Sql {
  return Prisma.sql`${classifiedAudienceSql(input.organizationId, input.purpose, input.def)},
    batch AS (
      SELECT * FROM classified WHERE h > ${input.afterHash} ORDER BY h LIMIT ${input.limit}
    ),
    ins AS (
      INSERT INTO "CampaignRecipient"
        (id, "campaignId", "organizationId", "userId", "emailHash", destination,
         "destinationMask", status, "finalAt", "createdAt", "updatedAt")
      SELECT gen_random_uuid()::text, ${input.campaignId}, ${input.organizationId}, b."userId", b.h,
        CASE WHEN b.granted AND NOT b.org_suppressed AND NOT b.global_suppressed THEN b.email END,
        left(split_part(b.email, '@', 1), 2) || '***@' || split_part(b.email, '@', 2),
        (CASE
          WHEN NOT b.granted THEN 'SKIPPED_CONSENT'
          WHEN b.org_suppressed OR b.global_suppressed THEN 'SKIPPED_SUPPRESSED'
          ELSE 'PENDING'
        END)::"CampaignRecipientStatus",
        CASE WHEN b.granted AND NOT b.org_suppressed AND NOT b.global_suppressed THEN NULL ELSE now() END,
        now(), now()
      FROM batch b
      ON CONFLICT ("campaignId", "emailHash") DO NOTHING
      RETURNING 1
    )
    SELECT (SELECT max(h) FROM batch) AS "lastHash",
           (SELECT count(*)::int FROM batch) AS "batchSize",
           (SELECT count(*)::int FROM ins) AS inserted`;
}
