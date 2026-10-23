import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CrmActivityInput } from '@eticketsgo/validation';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';
import { CrmScopeService, type CrmScope } from './crm-scope.service';
import { CrmErrors, CrmLeadsService, FOLLOW_UP_SELECT, staleVersion } from './crm-leads.service';

/** Where a lead has no timezone of its own, the day of a follow-up is its country's. */
const COUNTRY_ZONE: Record<string, string> = { IN: 'Asia/Kolkata', US: 'America/New_York' };

/** The calendar day an instant falls on, in a zone: "2026-10-23". */
export function dayIn(at: Date, zone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

export function followUpOpenKey(
  leadId: string,
  ownerUserId: string,
  dueAt: Date,
  zone: string,
): string {
  return `${leadId}:${ownerUserId}:${dayIn(dueAt, zone)}`;
}

/** A logged activity may be dated a little ahead (clock skew), never into the future. */
const FUTURE_TOLERANCE_MS = 10 * 60_000;

const ACTIVITY_SELECT = {
  id: true,
  leadId: true,
  type: true,
  occurredAt: true,
  outcome: true,
  notes: true,
  createdAt: true,
  responsible: { select: { id: true, fullName: true } },
  lead: { select: { id: true, organizationName: true, country: true, stage: true } },
} satisfies Prisma.CrmActivitySelect;

/**
 * Logged outreach and the follow-ups that come out of it.
 *
 * ── LOGGED, NOT SENT ───────────────────────────────────────────────────────────────
 * An EMAIL activity says somebody emailed the prospect from their own mailbox. This service
 * never contacts anybody, and nothing it stores is a delivery record.
 *
 * ── ONE OPEN FOLLOW-UP PER LEAD, OWNER AND DAY ─────────────────────────────────────
 * A follow-up carries `openKey` = lead:owner:day while it is OPEN, under a unique index. Two
 * "call them Tuesday" reminders for the same person are therefore refused by the database
 * itself, not only by a check that a double-click could race past.
 */
@Injectable()
export class CrmActivitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly scopes: CrmScopeService,
    private readonly leads: CrmLeadsService,
  ) {}

  /** Who may own work on this lead, as asked for by this caller. */
  private async resolveOwner(
    scope: CrmScope,
    lead: { teamId: string },
    requested: string | undefined,
    what: string,
  ): Promise<string> {
    const owner = requested ?? scope.actorId;
    // Yourself: the guard has checked your duty and the lead is one you can already see.
    if (owner === scope.actorId) return owner;
    if (!this.scopes.managesTeam(scope, lead.teamId)) throw this.scopes.managerOnly(what);
    await this.scopes.assertAssignable(lead.teamId, owner);
    return owner;
  }

  private zoneOf(lead: { timezone: string | null; country: string }): string {
    return lead.timezone || COUNTRY_ZONE[lead.country] || 'UTC';
  }

  /** Keep the lead's "next follow-up" in step, inside the caller's transaction. */
  async refreshNextFollowUp(tx: Prisma.TransactionClient, leadId: string): Promise<void> {
    const next = await tx.crmFollowUp.aggregate({
      where: { leadId, status: 'OPEN' },
      _min: { dueAt: true },
    });
    await tx.crmLead.update({
      where: { id: leadId },
      data: { nextFollowUpAt: next._min.dueAt ?? null },
    });
  }

  async log(actor: RequestUser, leadId: string, input: CrmActivityInput) {
    const scope = await this.scopes.resolve(actor);
    const lead = await this.leads.loadVisible(scope, leadId);
    if (input.occurredAt.getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'An activity is something that already happened. Schedule a follow-up for the future instead.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const responsibleUserId = await this.resolveOwner(
      scope,
      lead,
      input.responsibleUserId,
      'log an activity for somebody else',
    );
    const followUpOwner = input.followUp
      ? await this.resolveOwner(
          scope,
          lead,
          input.followUp.ownerUserId,
          'give a follow-up to somebody else',
        )
      : null;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const activity = await tx.crmActivity.create({
          data: {
            leadId,
            type: input.type,
            occurredAt: input.occurredAt,
            outcome: input.outcome ?? null,
            notes: input.notes ?? null,
            responsibleUserId,
            createdByUserId: actor.id,
          },
          select: ACTIVITY_SELECT,
        });
        // Latest wins, whatever order they are logged in.
        await tx.crmLead.updateMany({
          where: {
            id: leadId,
            OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: input.occurredAt } }],
          },
          data: { lastActivityAt: input.occurredAt },
        });
        let followUp = null;
        if (input.followUp && followUpOwner) {
          followUp = await tx.crmFollowUp.create({
            data: {
              leadId,
              ownerUserId: followUpOwner,
              dueAt: input.followUp.dueAt,
              title: input.followUp.title,
              notes: input.followUp.notes ?? null,
              openKey: followUpOpenKey(
                leadId,
                followUpOwner,
                input.followUp.dueAt,
                this.zoneOf(lead),
              ),
              activityId: activity.id,
              createdByUserId: actor.id,
            },
            select: FOLLOW_UP_SELECT,
          });
          await this.refreshNextFollowUp(tx, leadId);
        }
        return { activity, followUp };
      });
    } catch (err) {
      throw duplicateFollowUpOr(err);
    }
  }

  async listActivities(
    actor: RequestUser,
    q: {
      page: number;
      pageSize: number;
      from?: Date;
      to?: Date;
      type?: string;
      user?: string;
      country?: string;
      leadId?: string;
    },
  ) {
    const scope = await this.scopes.resolve(actor);
    const where: Prisma.CrmActivityWhereInput = {
      lead: { AND: [this.scopes.leadWhere(scope), q.country ? { country: q.country } : {}] },
      ...(q.leadId ? { leadId: q.leadId } : {}),
      ...(q.type ? { type: q.type as Prisma.EnumCrmActivityTypeFilter['equals'] } : {}),
      ...(q.user ? { responsibleUserId: q.user === 'me' ? actor.id : q.user } : {}),
      ...(q.from || q.to
        ? { occurredAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lt: q.to } : {}) } }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.crmActivity.count({ where }),
      this.prisma.crmActivity.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: ACTIVITY_SELECT,
      }),
    ]);
    return { data: rows, meta: pageMeta(q, total) };
  }

  // ── Follow-ups ──────────────────────────────────────────────────────────────

  async createFollowUp(
    actor: RequestUser,
    leadId: string,
    input: { dueAt: Date; title: string; notes?: string | null; ownerUserId?: string },
  ) {
    const scope = await this.scopes.resolve(actor);
    const lead = await this.leads.loadVisible(scope, leadId);
    const owner = await this.resolveOwner(
      scope,
      lead,
      input.ownerUserId,
      'give a follow-up to somebody else',
    );
    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.crmFollowUp.create({
          data: {
            leadId,
            ownerUserId: owner,
            dueAt: input.dueAt,
            title: input.title,
            notes: input.notes ?? null,
            openKey: followUpOpenKey(leadId, owner, input.dueAt, this.zoneOf(lead)),
            createdByUserId: actor.id,
          },
          select: FOLLOW_UP_SELECT,
        });
        await this.refreshNextFollowUp(tx, leadId);
        return created;
      });
    } catch (err) {
      throw duplicateFollowUpOr(err);
    }
  }

  /** A follow-up the caller may act on: its owner, or a manager of its lead's team. */
  private async loadFollowUp(scope: CrmScope, id: string) {
    const fu = await this.prisma.crmFollowUp.findUnique({
      where: { id },
      select: {
        id: true,
        leadId: true,
        ownerUserId: true,
        status: true,
        dueAt: true,
        version: true,
        lead: {
          select: { id: true, teamId: true, assignedToUserId: true, timezone: true, country: true },
        },
      },
    });
    const allowed =
      !!fu &&
      (this.scopes.managesTeam(scope, fu.lead.teamId) ||
        (fu.ownerUserId === scope.actorId && this.scopes.inTeam(scope, fu.lead.teamId)));
    if (!fu || !allowed) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Follow-up not found.', HttpStatus.NOT_FOUND);
    }
    return fu;
  }

  async close(
    actor: RequestUser,
    id: string,
    input: { version: number; note?: string | null },
    status: 'DONE' | 'CANCELLED',
  ) {
    const scope = await this.scopes.resolve(actor);
    const fu = await this.loadFollowUp(scope, id);
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.crmFollowUp.updateMany({
        where: { id, version: input.version, status: 'OPEN' },
        data: {
          status,
          openKey: null,
          completedAt: new Date(),
          completedByUserId: actor.id,
          completionNote: input.note ?? null,
          version: { increment: 1 },
        },
      });
      if (res.count === 0) throw staleVersion();
      await this.refreshNextFollowUp(tx, fu.leadId);
      return tx.crmFollowUp.findUniqueOrThrow({ where: { id }, select: FOLLOW_UP_SELECT });
    });
  }

  async reassign(
    actor: RequestUser,
    id: string,
    input: { version: number; ownerUserId: string; dueAt?: Date },
  ) {
    const scope = await this.scopes.resolve(actor);
    const fu = await this.loadFollowUp(scope, id);
    if (!this.scopes.managesTeam(scope, fu.lead.teamId))
      throw this.scopes.managerOnly('reassign follow-ups');
    if (fu.status !== 'OPEN') {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'Only an open follow-up can be reassigned.',
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.scopes.assertAssignable(fu.lead.teamId, input.ownerUserId);
    const dueAt = input.dueAt ?? fu.dueAt;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const res = await tx.crmFollowUp.updateMany({
          where: { id, version: input.version, status: 'OPEN' },
          data: {
            ownerUserId: input.ownerUserId,
            dueAt,
            openKey: followUpOpenKey(fu.leadId, input.ownerUserId, dueAt, this.zoneOf(fu.lead)),
            version: { increment: 1 },
          },
        });
        if (res.count === 0) throw staleVersion();
        await this.refreshNextFollowUp(tx, fu.leadId);
        await this.audit.recordInTransaction(tx, {
          actorUserId: actor.id,
          action: 'CRM_FOLLOW_UP_REASSIGNED',
          entityType: 'CrmFollowUp',
          entityId: id,
          metadata: { leadId: fu.leadId, fromUserId: fu.ownerUserId, toUserId: input.ownerUserId },
        });
        return tx.crmFollowUp.findUniqueOrThrow({ where: { id }, select: FOLLOW_UP_SELECT });
      });
    } catch (err) {
      throw duplicateFollowUpOr(err);
    }
  }

  async listFollowUps(
    actor: RequestUser,
    q: {
      page: number;
      pageSize: number;
      status: 'OPEN' | 'DONE' | 'CANCELLED';
      when: 'overdue' | 'today' | 'upcoming' | 'all';
      owner?: string;
      country?: string;
    },
  ) {
    const scope = await this.scopes.resolve(actor);
    const now = new Date();
    const dayAhead = new Date(now.getTime() + 24 * 3_600_000);
    const due: Prisma.DateTimeFilter | undefined =
      q.when === 'overdue'
        ? { lt: now }
        : q.when === 'today'
          ? { gte: now, lt: dayAhead }
          : q.when === 'upcoming'
            ? { gte: now }
            : undefined;
    const where: Prisma.CrmFollowUpWhereInput = {
      status: q.status,
      ...(due ? { dueAt: due } : {}),
      ...(q.owner ? { ownerUserId: q.owner === 'me' ? actor.id : q.owner } : {}),
      lead: { archivedAt: null, ...(q.country ? { country: q.country } : {}) },
      OR: [
        { lead: this.scopes.leadWhere(scope) },
        // Your own follow-ups, in a team you are in, even on a lead assigned to somebody else.
        { ownerUserId: actor.id, lead: { teamId: { in: scope.agentTeamIds } } },
      ],
    };
    const [total, rows] = await Promise.all([
      this.prisma.crmFollowUp.count({ where }),
      this.prisma.crmFollowUp.findMany({
        where,
        orderBy: [{ dueAt: q.status === 'OPEN' ? 'asc' : 'desc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: {
          ...FOLLOW_UP_SELECT,
          lead: {
            select: { id: true, organizationName: true, country: true, stage: true, teamId: true },
          },
        },
      }),
    ]);
    return { data: rows, meta: pageMeta(q, total) };
  }
}

function pageMeta(q: { page: number; pageSize: number }, total: number) {
  return {
    page: q.page,
    pageSize: q.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
  };
}

function duplicateFollowUpOr(err: unknown): unknown {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    return new AppException(
      CrmErrors.DUPLICATE_FOLLOW_UP,
      'There is already an open follow-up for this lead, for the same person, on that day.',
      HttpStatus.CONFLICT,
    );
  }
  return err;
}
