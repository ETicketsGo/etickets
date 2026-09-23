import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { marketFor } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Reading the audit log, as opposed to writing it.
 *
 * ── WHY A FLAT LIST WAS UNREADABLE ─────────────────────────────────────────────────
 * The console showed one row per entry, twenty to a page, newest first, with no dimension but
 * the action. Every confirmed booking, every check-in and every status change on the whole
 * platform in one column of prose. Looking for what one organizer did last Tuesday meant paging
 * through thousands of rows that had nothing to do with them.
 *
 * The log itself is right - an audit record is one action and must stay one row. What was
 * missing is a way in. So there are two reads: a SUMMARY that says which organizers, which
 * markets and which actions are in the window, and a filtered LIST for when somebody has
 * decided which of those they care about.
 *
 * ── WHY THE COUNTRY IS THE ORGANIZER'S, NOT THE EVENT'S ────────────────────────────
 * An audit row has no country of its own and never will: it records an action, not a sale. The
 * country here is where the organizer is registered, which is the right one for the question
 * this grouping answers - "what is happening in the India business" is about the sellers, and
 * that is a fact on the organization. It is NOT the place-of-supply country a tax report uses,
 * and nothing financial should be derived from it.
 */
export interface AuditFilters {
  action?: string;
  organizationId?: string;
  entityType?: string;
  /** ISO date or date-time. Inclusive. */
  from?: string;
  to?: string;
}

export interface AuditOrganizationGroup {
  organizationId: string | null;
  /** The organization's name, or "Platform" for an action with no organization. */
  name: string;
  /** Where the organization is registered, where it says. Null for platform actions. */
  country: string | null;
  count: number;
}

export interface AuditActionGroup {
  action: string;
  count: number;
}

export interface AuditSummary {
  total: number;
  /** Busiest organization first. */
  byOrganization: AuditOrganizationGroup[];
  /** Busiest action first. */
  byAction: AuditActionGroup[];
  /** Every action present in the window, sorted, for the filter dropdown. */
  actions: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AuditQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The filter, as one clause both reads share.
   *
   * A date-only `to` covers the whole of that day. Somebody filtering "to 18 September" means
   * the end of the 18th, and a naive parse would silently exclude everything that happened
   * after midnight - which on an audit log is the entire day.
   */
  private where(f: AuditFilters): Prisma.AuditLogWhereInput {
    const where: Prisma.AuditLogWhereInput = {};
    if (f.action) where.action = f.action;
    if (f.organizationId) where.organizationId = f.organizationId;
    if (f.entityType) where.entityType = f.entityType;
    const from = f.from ? new Date(f.from.length <= 10 ? `${f.from}T00:00:00.000Z` : f.from) : null;
    const to = f.to ? new Date(f.to.length <= 10 ? `${f.to}T23:59:59.999Z` : f.to) : null;
    if (from || to) {
      where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
    }
    return where;
  }

  /** Who is in this window, and what they were doing. */
  async summary(filters: AuditFilters): Promise<AuditSummary> {
    const where = this.where(filters);
    const [total, byOrgRaw, byActionRaw, allActions] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.groupBy({
        by: ['organizationId'],
        where,
        _count: { _all: true },
        orderBy: { _count: { organizationId: 'desc' } },
        take: 40,
      }),
      this.prisma.auditLog.groupBy({
        by: ['action'],
        where,
        _count: { _all: true },
      }),
      /*
        The dropdown lists the actions that are actually in the log, not a list typed into the
        page. The page had a hand-written array of fourteen, so an action added anywhere in the
        API - a suspension, a settlement run - was invisible to the filter until somebody
        remembered to add it here too.
      */
      this.prisma.auditLog.groupBy({ by: ['action'], where: {} }),
    ]);

    const orgIds = byOrgRaw.map((g) => g.organizationId).filter((id): id is string => id !== null);
    const orgs = orgIds.length
      ? await this.prisma.organization.findMany({
          where: { id: { in: orgIds } },
          select: { id: true, name: true, registeredCountry: true },
        })
      : [];
    const byId = new Map(orgs.map((o) => [o.id, o]));

    return {
      total,
      byOrganization: byOrgRaw.map((g) => {
        const org = g.organizationId ? byId.get(g.organizationId) : undefined;
        return {
          organizationId: g.organizationId,
          // A deleted organization leaves its audit rows behind, which is the point of an audit
          // log. Its id is all that is left to name it by.
          name: org?.name ?? (g.organizationId ? `Deleted organization` : 'Platform'),
          country: marketFor(org?.registeredCountry)?.name ?? org?.registeredCountry ?? null,
          count: g._count._all,
        };
      }),
      byAction: byActionRaw
        .map((g) => ({ action: g.action, count: g._count._all }))
        .sort((a, b) => b.count - a.count),
      actions: allActions.map((g) => g.action).sort(),
    };
  }

  /** One page of entries, newest first, with the organization named rather than an id. */
  async list(filters: AuditFilters, page: number, pageSize: number) {
    const where = this.where(filters);
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: { actor: { select: { email: true, fullName: true } } },
      }),
    ]);

    const orgIds = [
      ...new Set(rows.map((r) => r.organizationId).filter((id): id is string => !!id)),
    ];
    const orgs = orgIds.length
      ? await this.prisma.organization.findMany({
          where: { id: { in: orgIds } },
          select: { id: true, name: true },
        })
      : [];
    const nameById = new Map(orgs.map((o) => [o.id, o.name]));

    return {
      data: rows.map((r) => ({
        ...r,
        organizationName: r.organizationId ? (nameById.get(r.organizationId) ?? null) : null,
      })),
      meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  /** The default window the console opens on: the last 30 days. */
  static defaultFrom(): string {
    return new Date(Date.now() - 30 * DAY_MS).toISOString().slice(0, 10);
  }
}
