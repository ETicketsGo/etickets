import { Prisma } from '@prisma/client';
import { CRM_ACTIVATED_ORG_STATUS, type CrmDerivedActivation } from '@eticketsgo/shared-types';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * What the platform's own records say about prospects that were linked to an organization.
 *
 * ── NEVER TYPED ────────────────────────────────────────────────────────────────────
 * A sales desk is measured on conversions, so a conversion it can declare is one it will. The
 * stage a person sets is shown, but every "activated" or "first event" figure comes from here:
 *
 *   activated              the linked Organization's status is APPROVED - decided by the
 *                          organizer review flow (ORGANIZER_REVIEW), never by the CRM.
 *   firstPublishedEventAt  the earliest event of that organization that went live: its
 *                          publishedAt, or (for rows from before publishedAt was recorded) its
 *                          createdAt when its status shows it was published.
 *
 * Read-only: nothing here writes to an organization or an event.
 */

/** An event that went live, as SQL against an Event aliased `e`. */
export const EVENT_WENT_LIVE = Prisma.sql`(e."publishedAt" IS NOT NULL OR e."status" IN ('PUBLISHED', 'SOLD_OUT', 'COMPLETED'))`;

interface DerivedRow {
  id: string;
  name: string;
  status: string;
  createdAt: Date;
  firstPublishedAt: Date | null;
  publishedCount: bigint | number;
}

export async function derivedForOrganizations(
  prisma: PrismaService,
  organizationIds: string[],
): Promise<Map<string, CrmDerivedActivation>> {
  const out = new Map<string, CrmDerivedActivation>();
  const ids = [...new Set(organizationIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const rows = await prisma.$queryRaw<DerivedRow[]>`
    SELECT o."id", o."name", o."status"::text AS "status", o."createdAt",
           MIN(COALESCE(e."publishedAt", e."createdAt")) FILTER (WHERE ${EVENT_WENT_LIVE}) AS "firstPublishedAt",
           COUNT(e."id") FILTER (WHERE ${EVENT_WENT_LIVE}) AS "publishedCount"
      FROM "Organization" o
      LEFT JOIN "Event" e ON e."organizationId" = o."id"
     WHERE o."id" = ANY(${ids}::text[])
     GROUP BY o."id"`;
  for (const r of rows) {
    out.set(r.id, {
      linked: true,
      organization: {
        id: r.id,
        name: r.name,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
      },
      activated: r.status === CRM_ACTIVATED_ORG_STATUS,
      firstPublishedEventAt: r.firstPublishedAt ? r.firstPublishedAt.toISOString() : null,
      publishedEventCount: Number(r.publishedCount),
    });
  }
  return out;
}

export const NOT_LINKED: CrmDerivedActivation = {
  linked: false,
  organization: null,
  activated: false,
  firstPublishedEventAt: null,
  publishedEventCount: 0,
};
