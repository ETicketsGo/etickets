import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type CrmLeadStage } from '@prisma/client';
import {
  CRM_ACTIVATED_ORG_STATUS,
  CRM_LIMITS,
  CRM_TRANSITIONS,
  canTransition,
  isReopen,
  type CrmStage,
} from '@eticketsgo/shared-types';
import type {
  CrmCreateLeadInput,
  CrmLeadListQuery,
  CrmUpdateLeadInput,
} from '@eticketsgo/validation';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService, type AuditEntry } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';
import { CrmScopeService, type CrmScope } from './crm-scope.service';
import { leadKeys, sharedKeys, type DuplicateField, type LeadKeys } from './crm-normalize';
import { derivedForOrganizations, NOT_LINKED } from './crm-derived';
import { CSV_BOM, toCsv } from '../common/csv';

/** Codes a caller can branch on. */
export const CrmErrors = {
  STALE_VERSION: 'CRM_STALE_VERSION',
  DUPLICATE_LEAD: 'CRM_DUPLICATE_LEAD',
  TRANSITION_NOT_ALLOWED: 'CRM_TRANSITION_NOT_ALLOWED',
  ACTIVATION_NOT_PROVEN: 'CRM_ACTIVATION_NOT_PROVEN',
  ORGANIZATION_ALREADY_LINKED: 'CRM_ORGANIZATION_ALREADY_LINKED',
  DUPLICATE_FOLLOW_UP: 'CRM_DUPLICATE_FOLLOW_UP',
} as const;

export const LEAD_SELECT = {
  id: true,
  teamId: true,
  team: { select: { id: true, key: true, name: true, country: true } },
  country: true,
  organizationName: true,
  category: true,
  website: true,
  city: true,
  state: true,
  timezone: true,
  contactName: true,
  contactTitle: true,
  email: true,
  phone: true,
  socialLinks: true,
  source: true,
  priority: true,
  notes: true,
  tags: true,
  stage: true,
  stageChangedAt: true,
  lostReason: true,
  assignedToUserId: true,
  assignedTo: { select: { id: true, fullName: true } },
  organizationId: true,
  linkedAt: true,
  nextFollowUpAt: true,
  lastActivityAt: true,
  archivedAt: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CrmLeadSelect;

export interface DuplicateMatch {
  matchedOn: DuplicateField[];
  /** False: the match is outside the caller's scope, and nothing else about it is shown. */
  visible: boolean;
  id?: string;
  organizationName?: string;
  stage?: string;
  assignedTo?: string | null;
  archived?: boolean;
}

const MAX_DUPLICATES = 10;

export function staleVersion(): AppException {
  return new AppException(
    CrmErrors.STALE_VERSION,
    'Somebody changed this lead after you opened it. Reload it and try again.',
    HttpStatus.CONFLICT,
  );
}

/**
 * Prospects: create, read, edit, assign, move through the pipeline, archive, link.
 *
 * Every write names the version it read and is applied with `WHERE version = n`, so two people
 * editing - or two managers reassigning - cannot silently overwrite each other: the second one
 * is told and reloads. Important changes are audited with ids and field NAMES only; the audit
 * log never copies a prospect's contact details.
 */
@Injectable()
export class CrmLeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly scopes: CrmScopeService,
  ) {}

  // ── Reading ──────────────────────────────────────────────────────────────────

  listWhere(scope: CrmScope, q: Partial<CrmLeadListQuery>): Prisma.CrmLeadWhereInput {
    const and: Prisma.CrmLeadWhereInput[] = [this.scopes.leadWhere(scope)];
    and.push(q.archived ? { archivedAt: { not: null } } : { archivedAt: null });
    if (q.q) {
      const contains = { contains: q.q, mode: 'insensitive' as const };
      and.push({
        OR: [
          { organizationName: contains },
          { contactName: contains },
          { email: contains },
          { city: contains },
          { website: contains },
        ],
      });
    }
    if (q.stage) and.push({ stage: q.stage });
    if (q.country) and.push({ country: q.country });
    if (q.city) and.push({ city: { equals: q.city, mode: 'insensitive' } });
    if (q.teamId) and.push({ teamId: q.teamId });
    if (q.source) and.push({ source: q.source });
    if (q.priority) and.push({ priority: q.priority });
    if (q.tag) and.push({ tags: { has: q.tag } });
    if (q.linked !== undefined) and.push({ organizationId: q.linked ? { not: null } : null });
    if (q.assignee) {
      and.push({
        assignedToUserId:
          q.assignee === 'me' ? scope.actorId : q.assignee === 'none' ? null : q.assignee,
      });
    }
    const now = new Date();
    if (q.followUp === 'overdue') and.push({ nextFollowUpAt: { lt: now } });
    if (q.followUp === 'upcoming') and.push({ nextFollowUpAt: { gte: now } });
    if (q.followUp === 'none') and.push({ nextFollowUpAt: null });
    return { AND: and };
  }

  async list(actor: RequestUser, q: CrmLeadListQuery) {
    const scope = await this.scopes.resolve(actor);
    const where = this.listWhere(scope, q);
    const orderBy: Prisma.CrmLeadOrderByWithRelationInput[] =
      q.sort === 'created'
        ? [{ createdAt: 'desc' }]
        : q.sort === 'name'
          ? [{ organizationName: 'asc' }]
          : q.sort === 'nextFollowUp'
            ? [{ nextFollowUpAt: { sort: 'asc', nulls: 'last' } }]
            : q.sort === 'stageAge'
              ? [{ stageChangedAt: 'asc' }]
              : [{ updatedAt: 'desc' }];
    const [total, rows] = await Promise.all([
      this.prisma.crmLead.count({ where }),
      this.prisma.crmLead.findMany({
        where,
        orderBy: [...orderBy, { id: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: LEAD_SELECT,
      }),
    ]);
    const derived = await derivedForOrganizations(
      this.prisma,
      rows.map((r) => r.organizationId).filter((x): x is string => !!x),
    );
    return {
      data: rows.map((r) => ({
        ...r,
        derived: (r.organizationId && derived.get(r.organizationId)) || NOT_LINKED,
      })),
      meta: {
        page: q.page,
        pageSize: q.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
      },
    };
  }

  /**
   * The filtered list as CSV, for a manager.
   *
   * Only the teams the caller MANAGES, even if they also work in another team as an agent:
   * exporting is a manager's power, so it reaches exactly as far as their management does.
   * Capped, and refused above the cap rather than silently truncated. Audited with the count
   * and the filter names; never the rows.
   */
  async exportCsv(actor: RequestUser, q: Partial<CrmLeadListQuery>): Promise<string> {
    const full = await this.scopes.resolve(actor);
    if (full.managedTeamIds.length === 0) throw this.scopes.managerOnly('export leads');
    const scope: CrmScope = { ...full, agentTeamIds: [] };
    const where = this.listWhere(scope, q);
    const total = await this.prisma.crmLead.count({ where });
    if (total > CRM_LIMITS.exportRowsMax) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        `That is ${total} leads. Export at most ${CRM_LIMITS.exportRowsMax} at a time: narrow the filters.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    const rows = await this.prisma.crmLead.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: LEAD_SELECT,
    });
    const derived = await derivedForOrganizations(
      this.prisma,
      rows.map((r) => r.organizationId).filter((x): x is string => !!x),
    );
    const iso = (d: Date | null) => (d ? d.toISOString() : '');
    const csv = toCsv(
      [
        'Lead id',
        'Team',
        'Country',
        'Organization',
        'Category',
        'Website',
        'City',
        'State',
        'Timezone',
        'Contact name',
        'Contact title',
        'Email',
        'Phone',
        'Social links',
        'Source',
        'Priority',
        'Tags',
        'Stage (set by a person)',
        'In stage since',
        'Assigned to',
        'Linked organization id',
        'Organizer approved (from platform data)',
        'First published event (from platform data)',
        'Next follow-up',
        'Last logged activity',
        'Created',
      ],
      rows.map((r) => {
        const d = (r.organizationId && derived.get(r.organizationId)) || NOT_LINKED;
        return [
          r.id,
          r.team.key,
          r.country,
          r.organizationName,
          r.category,
          r.website,
          r.city,
          r.state,
          r.timezone,
          r.contactName,
          r.contactTitle,
          r.email,
          r.phone,
          r.socialLinks.join(' '),
          r.source,
          r.priority,
          r.tags.join(';'),
          r.stage,
          iso(r.stageChangedAt),
          r.assignedTo?.fullName ?? '',
          r.organizationId ?? '',
          d.activated ? 'yes' : 'no',
          d.firstPublishedEventAt ?? '',
          iso(r.nextFollowUpAt),
          iso(r.lastActivityAt),
          iso(r.createdAt),
        ];
      }),
    );
    await this.audit.record({
      actorUserId: actor.id,
      action: 'CRM_LEADS_EXPORTED',
      entityType: 'CrmLead',
      metadata: {
        count: rows.length,
        filters: Object.keys(q).filter((k) => (q as Record<string, unknown>)[k] !== undefined),
        teamIds: scope.managedTeamIds,
      },
    });
    return CSV_BOM + csv;
  }

  /** One lead the caller may see, or a 404 that does not confirm it exists. */
  async loadVisible(scope: CrmScope, id: string) {
    const lead = await this.prisma.crmLead.findUnique({ where: { id }, select: LEAD_SELECT });
    if (!lead || !this.scopes.canSee(scope, lead)) throw this.scopes.notFound();
    return lead;
  }

  async detail(actor: RequestUser, id: string) {
    const scope = await this.scopes.resolve(actor);
    const lead = await this.loadVisible(scope, id);
    const [stageHistory, activities, followUps, derived] = await Promise.all([
      this.prisma.crmLeadStageChange.findMany({
        where: { leadId: id },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          fromStage: true,
          toStage: true,
          note: true,
          createdAt: true,
          changedBy: { select: { id: true, fullName: true } },
        },
      }),
      this.prisma.crmActivity.findMany({
        where: { leadId: id },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: 100,
        select: {
          id: true,
          type: true,
          occurredAt: true,
          outcome: true,
          notes: true,
          createdAt: true,
          responsible: { select: { id: true, fullName: true } },
        },
      }),
      this.prisma.crmFollowUp.findMany({
        where: { leadId: id },
        orderBy: [{ status: 'asc' }, { dueAt: 'asc' }],
        take: 100,
        select: FOLLOW_UP_SELECT,
      }),
      lead.organizationId
        ? derivedForOrganizations(this.prisma, [lead.organizationId])
        : Promise.resolve(new Map()),
    ]);
    const manages = this.scopes.managesTeam(scope, lead.teamId);
    return {
      ...lead,
      derived: (lead.organizationId && derived.get(lead.organizationId)) || NOT_LINKED,
      stageHistory,
      activities,
      followUps,
      allowedStages: CRM_TRANSITIONS[lead.stage as CrmStage].filter(
        (to) => manages || !isReopen(lead.stage as CrmStage, to),
      ),
      access: { manage: manages, work: true },
    };
  }

  // ── Duplicates ──────────────────────────────────────────────────────────────

  async findDuplicates(
    scope: CrmScope,
    keys: LeadKeys,
    excludeLeadId?: string,
  ): Promise<DuplicateMatch[]> {
    const or: Prisma.CrmLeadWhereInput[] = [];
    if (keys.nameKey) or.push({ nameKey: keys.nameKey });
    if (keys.domainKey) or.push({ domainKey: keys.domainKey });
    if (keys.emailKey) or.push({ emailKey: keys.emailKey });
    if (keys.phoneKey) or.push({ phoneKey: keys.phoneKey });
    if (or.length === 0) return [];
    /*
      Checked against EVERY lead, not only those the caller can see: the point is to stop two
      teams chasing the same organizer. What is returned about a match outside the caller's
      scope is only that it exists and which key matched - never its id, name or owner.
    */
    const rows = await this.prisma.crmLead.findMany({
      where: { OR: or, ...(excludeLeadId ? { id: { not: excludeLeadId } } : {}) },
      take: MAX_DUPLICATES,
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        teamId: true,
        assignedToUserId: true,
        organizationName: true,
        stage: true,
        archivedAt: true,
        nameKey: true,
        domainKey: true,
        emailKey: true,
        phoneKey: true,
        assignedTo: { select: { fullName: true } },
      },
    });
    return rows.map((r) => {
      const matchedOn = sharedKeys(keys, r);
      if (!this.scopes.canSee(scope, r)) return { matchedOn, visible: false };
      return {
        matchedOn,
        visible: true,
        id: r.id,
        organizationName: r.organizationName,
        stage: r.stage,
        assignedTo: r.assignedTo?.fullName ?? null,
        archived: !!r.archivedAt,
      };
    });
  }

  async checkDuplicates(
    actor: RequestUser,
    input: {
      organizationName?: string;
      website?: string | null;
      email?: string | null;
      phone?: string | null;
      country?: string;
      excludeLeadId?: string;
    },
  ) {
    const scope = await this.scopes.resolve(actor);
    const matches = await this.findDuplicates(scope, leadKeys(input), input.excludeLeadId);
    return { matches };
  }

  // ── Writing ─────────────────────────────────────────────────────────────────

  async create(actor: RequestUser, input: CrmCreateLeadInput) {
    const scope = await this.scopes.resolve(actor);
    const team = await this.prisma.crmTeam.findUnique({ where: { id: input.teamId } });
    if (!team || !team.active || !this.scopes.inTeam(scope, team.id)) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'You are not a member of that team.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (input.country !== team.country) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        `This team works prospects in ${team.country}. Choose the team for ${input.country}.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    const manages = this.scopes.managesTeam(scope, team.id);
    let assignedToUserId: string | null;
    if (manages) {
      assignedToUserId = input.assignedToUserId ?? null;
      if (assignedToUserId) await this.scopes.assertAssignable(team.id, assignedToUserId);
    } else {
      // An agent's lead is theirs. Handing work to somebody else is a manager's decision.
      if (input.assignedToUserId && input.assignedToUserId !== actor.id) {
        throw this.scopes.managerOnly('assign a lead to somebody else');
      }
      assignedToUserId = actor.id;
    }

    const keys = leadKeys(input);
    const duplicates = await this.findDuplicates(scope, keys);
    if (duplicates.length > 0) {
      if (!input.confirmDuplicate) {
        throw new AppException(
          CrmErrors.DUPLICATE_LEAD,
          'This looks like a prospect that is already in the CRM.',
          HttpStatus.CONFLICT,
          { matches: duplicates },
        );
      }
      if (!manages) {
        throw new AppException(
          CrmErrors.DUPLICATE_LEAD,
          'This looks like a prospect that is already in the CRM. Ask your manager to add it if it is really a different organization.',
          HttpStatus.CONFLICT,
          { matches: duplicates },
        );
      }
    }

    const lead = await this.prisma.$transaction(async (tx) => {
      const created = await tx.crmLead.create({
        data: {
          ...(this.fieldData(input) as Omit<Prisma.CrmLeadUncheckedCreateInput, 'teamId'>),
          organizationName: input.organizationName,
          teamId: team.id,
          country: team.country,
          ...keys,
          source: input.source,
          priority: input.priority ?? 'MEDIUM',
          assignedToUserId,
          createdByUserId: actor.id,
        },
        select: LEAD_SELECT,
      });
      await tx.crmLeadStageChange.create({
        data: {
          leadId: created.id,
          fromStage: null,
          toStage: 'IDENTIFIED',
          changedByUserId: actor.id,
        },
      });
      await this.audit.recordInTransaction(tx, {
        actorUserId: actor.id,
        action: 'CRM_LEAD_CREATED',
        entityType: 'CrmLead',
        entityId: created.id,
        metadata: {
          teamId: team.id,
          country: team.country,
          source: input.source,
          assignedToUserId,
          duplicateOverride: duplicates.length > 0,
        },
      });
      return created;
    });
    return { ...lead, derived: NOT_LINKED };
  }

  async update(actor: RequestUser, id: string, input: CrmUpdateLeadInput) {
    const scope = await this.scopes.resolve(actor);
    const lead = await this.loadVisible(scope, id);
    const fields = this.fieldData(input);
    const changed = Object.keys(fields).filter(
      (k) =>
        JSON.stringify((lead as Record<string, unknown>)[k]) !==
        JSON.stringify((fields as Record<string, unknown>)[k]),
    );
    if (input.source !== undefined && input.source !== lead.source) changed.push('source');
    if (input.priority !== undefined && input.priority !== lead.priority) changed.push('priority');
    const keys = leadKeys({
      organizationName: fields.organizationName ?? lead.organizationName,
      website: 'website' in fields ? fields.website : lead.website,
      email: 'email' in fields ? fields.email : lead.email,
      phone: 'phone' in fields ? fields.phone : lead.phone,
      country: lead.country,
    });

    const updated = await this.prisma.$transaction(async (tx) => {
      const res = await tx.crmLead.updateMany({
        where: { id, version: input.version },
        data: {
          ...fields,
          ...keys,
          ...(input.source ? { source: input.source } : {}),
          ...(input.priority ? { priority: input.priority } : {}),
          version: { increment: 1 },
        },
      });
      if (res.count === 0) throw staleVersion();
      if (changed.length > 0) {
        await this.audit.recordInTransaction(tx, {
          actorUserId: actor.id,
          action: 'CRM_LEAD_UPDATED',
          entityType: 'CrmLead',
          entityId: id,
          // Which fields, never their values: these are a prospect's contact details.
          metadata: { fields: [...new Set(changed)].sort() },
        });
      }
      return tx.crmLead.findUniqueOrThrow({ where: { id }, select: LEAD_SELECT });
    });
    // Editing is never blocked by a duplicate; it is reported so the editor can merge.
    const duplicates = await this.findDuplicates(scope, keys, id);
    return { lead: updated, duplicates };
  }

  async assign(
    actor: RequestUser,
    id: string,
    input: { version: number; assignedToUserId: string | null; note?: string | null },
  ) {
    const scope = await this.scopes.resolve(actor);
    const lead = await this.loadVisible(scope, id);
    if (!this.scopes.managesTeam(scope, lead.teamId)) throw this.scopes.managerOnly('assign leads');
    if (input.assignedToUserId)
      await this.scopes.assertAssignable(lead.teamId, input.assignedToUserId);
    const entry: AuditEntry = {
      actorUserId: actor.id,
      action: 'CRM_LEAD_ASSIGNED',
      entityType: 'CrmLead',
      entityId: id,
      metadata: {
        fromUserId: lead.assignedToUserId,
        toUserId: input.assignedToUserId,
        note: input.note ?? null,
      },
    };
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.crmLead.updateMany({
        where: { id, version: input.version },
        data: { assignedToUserId: input.assignedToUserId, version: { increment: 1 } },
      });
      if (res.count === 0) throw staleVersion();
      await this.audit.recordInTransaction(tx, entry);
      return tx.crmLead.findUniqueOrThrow({ where: { id }, select: LEAD_SELECT });
    });
  }

  async changeStage(
    actor: RequestUser,
    id: string,
    input: { version: number; stage: CrmStage; note?: string | null; lostReason?: string | null },
  ) {
    const scope = await this.scopes.resolve(actor);
    const lead = await this.loadVisible(scope, id);
    const from = lead.stage as CrmStage;
    const to = input.stage;
    if (!canTransition(from, to)) {
      throw new AppException(
        CrmErrors.TRANSITION_NOT_ALLOWED,
        `A lead cannot move from ${from} to ${to}.`,
        HttpStatus.BAD_REQUEST,
        { allowed: CRM_TRANSITIONS[from] },
      );
    }
    if (isReopen(from, to)) {
      if (!this.scopes.managesTeam(scope, lead.teamId))
        throw this.scopes.managerOnly('reopen a lost lead');
      if (!input.note) {
        throw new AppException(
          ErrorCodes.VALIDATION_FAILED,
          'Say why this lead is being reopened.',
          HttpStatus.BAD_REQUEST,
        );
      }
    }
    if (to === 'LOST' && !input.lostReason) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'Say why this lead was lost.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (to === 'ACTIVATED') {
      /*
        The one stage a person cannot declare. It is accepted only while the platform itself
        says so: a linked organization that the organizer review flow APPROVED. A lead that
        merely "feels activated" stays in ONBOARDING, and the dashboards count the derived
        figure either way.
      */
      const org = lead.organizationId
        ? await this.prisma.organization.findUnique({
            where: { id: lead.organizationId },
            select: { status: true },
          })
        : null;
      if (!org || org.status !== CRM_ACTIVATED_ORG_STATUS) {
        throw new AppException(
          CrmErrors.ACTIVATION_NOT_PROVEN,
          org
            ? `The linked organization is ${org.status}, not approved. A lead is activated when the organizer has been approved to sell.`
            : 'Link this lead to the organizer account first. A lead is activated when that organizer has been approved to sell.',
          HttpStatus.CONFLICT,
        );
      }
    }
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.crmLead.updateMany({
        where: { id, version: input.version, stage: from as CrmLeadStage },
        data: {
          stage: to,
          stageChangedAt: now,
          lostReason: to === 'LOST' ? input.lostReason : null,
          version: { increment: 1 },
        },
      });
      if (res.count === 0) throw staleVersion();
      await tx.crmLeadStageChange.create({
        data: {
          leadId: id,
          fromStage: from,
          toStage: to,
          changedByUserId: actor.id,
          note: input.note ?? (to === 'LOST' ? input.lostReason : null) ?? null,
          createdAt: now,
        },
      });
      await this.audit.recordInTransaction(tx, {
        actorUserId: actor.id,
        action: 'CRM_LEAD_STAGE_CHANGED',
        entityType: 'CrmLead',
        entityId: id,
        metadata: { from, to, reopen: isReopen(from, to) },
      });
      return tx.crmLead.findUniqueOrThrow({ where: { id }, select: LEAD_SELECT });
    });
  }

  async archive(actor: RequestUser, id: string, input: { version: number; archived: boolean }) {
    const scope = await this.scopes.resolve(actor);
    const lead = await this.loadVisible(scope, id);
    if (!this.scopes.managesTeam(scope, lead.teamId))
      throw this.scopes.managerOnly('archive leads');
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.crmLead.updateMany({
        where: { id, version: input.version },
        data: { archivedAt: input.archived ? new Date() : null, version: { increment: 1 } },
      });
      if (res.count === 0) throw staleVersion();
      await this.audit.recordInTransaction(tx, {
        actorUserId: actor.id,
        action: input.archived ? 'CRM_LEAD_ARCHIVED' : 'CRM_LEAD_RESTORED',
        entityType: 'CrmLead',
        entityId: id,
      });
      return tx.crmLead.findUniqueOrThrow({ where: { id }, select: LEAD_SELECT });
    });
  }

  // ── Conversion: link to an organization that ALREADY exists ──────────────────

  async searchOrganizations(actor: RequestUser, q: string) {
    const scope = await this.scopes.resolve(actor);
    if (scope.managedTeamIds.length === 0) throw this.scopes.managerOnly('link organizations');
    const term = q.trim();
    const orgs = await this.prisma.organization.findMany({
      where: {
        OR: [
          { name: { contains: term, mode: 'insensitive' } },
          { legalName: { contains: term, mode: 'insensitive' } },
          { slug: { contains: term.toLowerCase() } },
          { contactEmail: { equals: term.toLowerCase(), mode: 'insensitive' } },
        ],
      },
      take: 10,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        registeredCountry: true,
        createdAt: true,
        crmLead: { select: { id: true } },
      },
    });
    // Whether it is already somebody's conversion, but not whose: the lead may be out of scope.
    return orgs.map(({ crmLead, ...o }) => ({ ...o, alreadyLinked: !!crmLead }));
  }

  async linkOrganization(
    actor: RequestUser,
    id: string,
    input: { version: number; organizationId: string },
  ) {
    const scope = await this.scopes.resolve(actor);
    const lead = await this.loadVisible(scope, id);
    if (!this.scopes.managesTeam(scope, lead.teamId))
      throw this.scopes.managerOnly('link a lead to an organization');
    const org = await this.prisma.organization.findUnique({
      where: { id: input.organizationId },
      select: { id: true, crmLead: { select: { id: true } } },
    });
    if (!org) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Organization not found.', HttpStatus.NOT_FOUND);
    }
    if (org.crmLead && org.crmLead.id !== id) throw alreadyLinked();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const res = await tx.crmLead.updateMany({
          where: { id, version: input.version },
          data: {
            organizationId: org.id,
            linkedAt: new Date(),
            linkedByUserId: actor.id,
            version: { increment: 1 },
          },
        });
        if (res.count === 0) throw staleVersion();
        await this.audit.recordInTransaction(tx, {
          actorUserId: actor.id,
          organizationId: org.id,
          action: 'CRM_LEAD_ORGANIZATION_LINKED',
          entityType: 'CrmLead',
          entityId: id,
          metadata: { organizationId: org.id, previousOrganizationId: lead.organizationId },
        });
        return tx.crmLead.findUniqueOrThrow({ where: { id }, select: LEAD_SELECT });
      });
    } catch (err) {
      // Two managers linking the same organization at once: the unique index decides.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw alreadyLinked();
      }
      throw err;
    }
  }

  async unlinkOrganization(actor: RequestUser, id: string, input: { version: number }) {
    const scope = await this.scopes.resolve(actor);
    const lead = await this.loadVisible(scope, id);
    if (!this.scopes.managesTeam(scope, lead.teamId))
      throw this.scopes.managerOnly('unlink an organization');
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.crmLead.updateMany({
        where: { id, version: input.version },
        data: {
          organizationId: null,
          linkedAt: null,
          linkedByUserId: null,
          version: { increment: 1 },
        },
      });
      if (res.count === 0) throw staleVersion();
      await this.audit.recordInTransaction(tx, {
        actorUserId: actor.id,
        organizationId: lead.organizationId,
        action: 'CRM_LEAD_ORGANIZATION_UNLINKED',
        entityType: 'CrmLead',
        entityId: id,
        metadata: { organizationId: lead.organizationId },
      });
      return tx.crmLead.findUniqueOrThrow({ where: { id }, select: LEAD_SELECT });
    });
  }

  /** The editable columns of an input, with '' already turned into null by the schema. */
  private fieldData(input: Partial<CrmCreateLeadInput>) {
    const out: Record<string, unknown> = {};
    const keys = [
      'organizationName',
      'category',
      'website',
      'city',
      'state',
      'timezone',
      'contactName',
      'contactTitle',
      'email',
      'phone',
      'socialLinks',
      'notes',
      'tags',
    ] as const;
    for (const k of keys) if (input[k] !== undefined) out[k] = input[k];
    return out as {
      organizationName?: string;
      website?: string | null;
      email?: string | null;
      phone?: string | null;
    } & Record<string, unknown>;
  }
}

function alreadyLinked(): AppException {
  return new AppException(
    CrmErrors.ORGANIZATION_ALREADY_LINKED,
    'That organization is already linked to another lead. One organization can be won once.',
    HttpStatus.CONFLICT,
  );
}

export const FOLLOW_UP_SELECT = {
  id: true,
  leadId: true,
  dueAt: true,
  title: true,
  notes: true,
  status: true,
  version: true,
  completedAt: true,
  completionNote: true,
  createdAt: true,
  owner: { select: { id: true, fullName: true } },
} satisfies Prisma.CrmFollowUpSelect;
