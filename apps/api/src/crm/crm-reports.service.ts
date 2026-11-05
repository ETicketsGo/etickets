import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CRM_ACTIVITY_TYPES, CRM_PIPELINE, CRM_STAGES } from '@eticketsgo/shared-types';
import type { CrmReportQuery } from '@eticketsgo/validation';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../common/decorators';
import { CrmScopeService, type CrmScope } from './crm-scope.service';
import { EVENT_WENT_LIVE } from './crm-derived';
import { toCsv, type CsvValue } from '../common/csv';

/**
 * Organizer acquisition reporting, aggregated in SQL over the caller's scope.
 *
 * ── RULES EVERY FIGURE HERE KEEPS ──────────────────────────────────────────────────
 *  - Scope first. Every query starts from the leads the caller may see (CrmScopeService), so a
 *    manager's report is their teams and an agent's dashboard is their own leads.
 *  - Activation and first events are DERIVED: an approved linked organization, and that
 *    organization's own events. The manual stage is reported beside them, never instead.
 *  - Activities are LOGGED outreach. Nothing here is, or is labelled as, a message sent.
 *  - A rate is never returned on its own: each comes as a numerator and the denominator it
 *    is a share of, so the console can say "12 of 40" and never a bare 30% of nothing.
 *  - Archived leads are left out: archiving is how junk rows are cleared.
 *
 * "Reached" a stage means the lead's history includes that stage or any later one on the
 * pipeline, so a lead that skipped from Identified to Interested still counts as contacted and
 * the funnel never widens downwards. LOST is reported on its own.
 */

const PIPE = CRM_PIPELINE.map(String);
const stageIdx = (s: string) => PIPE.indexOf(s) + 1;

type Num = bigint | number | null;
const n = (v: Num | undefined) => Number(v ?? 0);

export interface Ratio {
  numerator: number;
  denominator: number;
}
const ratio = (numerator: number, denominator: number): Ratio => ({ numerator, denominator });

@Injectable()
export class CrmReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: CrmScopeService,
  ) {}

  /** The WHERE for leads: scope, not archived, and the filters (date only when asked). */
  private where(
    scope: CrmScope,
    q: Partial<CrmReportQuery>,
    opts: { cohort: boolean },
  ): Prisma.Sql {
    const c: Prisma.Sql[] = [this.scopes.leadSql(scope, 'l'), Prisma.sql`l."archivedAt" IS NULL`];
    if (q.country) c.push(Prisma.sql`l."country" = ${q.country}`);
    if (q.city) c.push(Prisma.sql`lower(l."city") = lower(${q.city})`);
    if (q.source) c.push(Prisma.sql`l."source" = ${q.source}`);
    if (q.stage) c.push(Prisma.sql`l."stage"::text = ${q.stage}`);
    if (q.assignee) {
      const who = q.assignee === 'me' ? scope.actorId : q.assignee;
      c.push(
        q.assignee === 'none'
          ? Prisma.sql`l."assignedToUserId" IS NULL`
          : Prisma.sql`l."assignedToUserId" = ${who}`,
      );
    }
    if (opts.cohort && q.from) c.push(Prisma.sql`l."createdAt" >= ${q.from}`);
    if (opts.cohort && q.to) c.push(Prisma.sql`l."createdAt" < ${q.to}`);
    return Prisma.join(c, ' AND ');
  }

  /** The lead plus what the platform says about it: org status, first event, furthest stage. */
  private readonly from = Prisma.sql`
    FROM "CrmLead" l
    LEFT JOIN "Organization" o ON o."id" = l."organizationId"
    LEFT JOIN (
      SELECT e."organizationId", MIN(COALESCE(e."publishedAt", e."createdAt")) AS "firstAt"
        FROM "Event" e
       WHERE ${EVENT_WENT_LIVE}
         AND e."organizationId" IN (SELECT "organizationId" FROM "CrmLead" WHERE "organizationId" IS NOT NULL)
       GROUP BY e."organizationId"
    ) fe ON fe."organizationId" = l."organizationId"
    LEFT JOIN (
      SELECT sc."leadId", MAX(array_position(${PIPE}::text[], sc."toStage"::text)) AS "maxIdx"
        FROM "CrmLeadStageChange" sc
       GROUP BY sc."leadId"
    ) mx ON mx."leadId" = l."id"`;

  /** Per-group counts every breakdown shares. */
  private readonly measures = Prisma.sql`
      COUNT(*) AS "total",
      COUNT(*) FILTER (WHERE mx."maxIdx" >= ${stageIdx('CONTACTED')}) AS "contacted",
      COUNT(*) FILTER (WHERE mx."maxIdx" >= ${stageIdx('RESPONDED_INTERESTED')}) AS "interested",
      COUNT(*) FILTER (WHERE mx."maxIdx" >= ${stageIdx('DEMO_COMPLETED')}) AS "demoCompleted",
      COUNT(*) FILTER (WHERE mx."maxIdx" >= ${stageIdx('ONBOARDING')}) AS "onboarding",
      COUNT(*) FILTER (WHERE l."stage" = 'LOST') AS "lost",
      COUNT(*) FILTER (WHERE l."organizationId" IS NOT NULL) AS "linked",
      COUNT(*) FILTER (WHERE o."status" = 'APPROVED') AS "activated",
      COUNT(*) FILTER (WHERE o."status" = 'APPROVED' AND fe."firstAt" IS NOT NULL) AS "firstEvent"`;

  private window(q: Partial<CrmReportQuery>, days: number) {
    const to = q.to ?? new Date();
    const from = q.from ?? new Date(to.getTime() - days * 86_400_000);
    return { from, to };
  }

  // ── Overview (agents too: their own leads) ───────────────────────────────────

  async overview(actor: RequestUser, q: CrmReportQuery) {
    const scope = await this.scopes.resolve(actor);
    const { from, to } = this.window(q, 30);
    const where = this.where(scope, q, { cohort: false });
    const [row] = await this.prisma.$queryRaw<Record<string, Num>[]>`
      SELECT ${this.measures},
             COUNT(*) FILTER (WHERE l."createdAt" >= ${from} AND l."createdAt" < ${to}) AS "new",
             ${Prisma.join(
               CRM_STAGES.map(
                 (s) =>
                   Prisma.sql`COUNT(*) FILTER (WHERE l."stage" = ${s}::"CrmLeadStage") AS ${Prisma.raw(`"stage_${s}"`)}`,
               ),
               ', ',
             )}
        ${this.from}
       WHERE ${where}`;
    const [fu] = await this.prisma.$queryRaw<Record<string, Num>[]>`
      SELECT COUNT(*) FILTER (WHERE f."dueAt" < now()) AS "overdue",
             COUNT(*) FILTER (WHERE f."dueAt" >= now() AND f."dueAt" < now() + interval '7 days') AS "dueThisWeek"
        FROM "CrmFollowUp" f
        JOIN "CrmLead" l ON l."id" = f."leadId"
       WHERE f."status" = 'OPEN' AND ${where}`;
    const [act] = await this.prisma.$queryRaw<Record<string, Num>[]>`
      SELECT COUNT(*) AS "logged"
        FROM "CrmActivity" a
        JOIN "CrmLead" l ON l."id" = a."leadId"
       WHERE a."occurredAt" >= ${from} AND a."occurredAt" < ${to} AND ${where}`;
    const total = n(row?.total);
    return {
      window: { from: from.toISOString(), to: to.toISOString() },
      totalProspects: total,
      newInWindow: n(row?.new),
      currentStage: Object.fromEntries(CRM_STAGES.map((s) => [s, n(row?.[`stage_${s}`])])),
      derived: {
        linked: ratio(n(row?.linked), total),
        activated: ratio(n(row?.activated), total),
        activatedWithFirstEvent: ratio(n(row?.firstEvent), n(row?.activated)),
      },
      followUps: { overdue: n(fu?.overdue), dueThisWeek: n(fu?.dueThisWeek) },
      activitiesLoggedInWindow: n(act?.logged),
    };
  }

  // ── Manager reports ─────────────────────────────────────────────────────────

  async funnel(actor: RequestUser, q: CrmReportQuery) {
    const scope = await this.scopes.resolve(actor);
    const [row] = await this.prisma.$queryRaw<Record<string, Num>[]>`
      SELECT COUNT(*) AS "cohort",
             ${Prisma.join(
               PIPE.map(
                 (s, i) =>
                   Prisma.sql`COUNT(*) FILTER (WHERE mx."maxIdx" >= ${i + 1}) AS ${Prisma.raw(`"r_${s}"`)}`,
               ),
               ', ',
             )},
             COUNT(*) FILTER (WHERE l."stage" = 'LOST') AS "lost",
             COUNT(*) FILTER (WHERE o."status" = 'APPROVED') AS "activated",
             COUNT(*) FILTER (WHERE o."status" = 'APPROVED' AND fe."firstAt" IS NOT NULL) AS "firstEvent"
        ${this.from}
       WHERE ${this.where(scope, q, { cohort: true })}`;
    const cohort = n(row?.cohort);
    const reached = PIPE.map((s) => ({ stage: s, reached: n(row?.[`r_${s}`]) }));
    return {
      cohort,
      cohortDefinition: 'Leads created in the date range (all leads when no range is given).',
      stages: reached.map((r) => ({ ...r, ofCohort: ratio(r.reached, cohort) })),
      conversionByStage: reached.slice(1).map((r, i) => ({
        from: reached[i].stage,
        to: r.stage,
        rate: ratio(r.reached, reached[i].reached),
      })),
      lost: ratio(n(row?.lost), cohort),
      derived: {
        activated: ratio(n(row?.activated), cohort),
        firstEvent: ratio(n(row?.firstEvent), n(row?.activated)),
      },
    };
  }

  private async grouped(scope: CrmScope, q: CrmReportQuery, group: Prisma.Sql) {
    const rows = await this.prisma.$queryRaw<Record<string, Num | string>[]>`
      SELECT ${group} AS "key", ${this.measures}
        ${this.from}
       WHERE ${this.where(scope, q, { cohort: true })}
       GROUP BY 1
       ORDER BY 2 DESC, 1 ASC`;
    return rows.map((r) => {
      const total = n(r.total as Num);
      return {
        key: (r.key as string | null) ?? null,
        total,
        contacted: ratio(n(r.contacted as Num), total),
        interested: ratio(n(r.interested as Num), total),
        demoCompleted: ratio(n(r.demoCompleted as Num), total),
        onboarding: ratio(n(r.onboarding as Num), total),
        lost: ratio(n(r.lost as Num), total),
        linked: ratio(n(r.linked as Num), total),
        activated: ratio(n(r.activated as Num), total),
        firstEvent: ratio(n(r.firstEvent as Num), n(r.activated as Num)),
      };
    });
  }

  async byCountry(actor: RequestUser, q: CrmReportQuery) {
    const scope = await this.scopes.resolve(actor);
    return { rows: await this.grouped(scope, q, Prisma.sql`l."country"`) };
  }

  async bySource(actor: RequestUser, q: CrmReportQuery) {
    const scope = await this.scopes.resolve(actor);
    return { rows: await this.grouped(scope, q, Prisma.sql`l."source"`) };
  }

  async byEmployee(actor: RequestUser, q: CrmReportQuery) {
    const scope = await this.scopes.resolve(actor);
    const { from, to } = this.window(q, 30);
    const leadRows = await this.grouped(scope, q, Prisma.sql`l."assignedToUserId"`);
    const where = this.where(scope, q, { cohort: false });
    const acts = await this.prisma.$queryRaw<{ userId: string; type: string; count: Num }[]>`
      SELECT a."responsibleUserId" AS "userId", a."type"::text AS "type", COUNT(*) AS "count"
        FROM "CrmActivity" a JOIN "CrmLead" l ON l."id" = a."leadId"
       WHERE a."occurredAt" >= ${from} AND a."occurredAt" < ${to} AND ${where}
       GROUP BY 1, 2`;
    const moves = await this.prisma.$queryRaw<{ userId: string; count: Num }[]>`
      SELECT sc."changedByUserId" AS "userId", COUNT(*) AS "count"
        FROM "CrmLeadStageChange" sc JOIN "CrmLead" l ON l."id" = sc."leadId"
       WHERE sc."fromStage" IS NOT NULL AND sc."createdAt" >= ${from} AND sc."createdAt" < ${to} AND ${where}
       GROUP BY 1`;
    const overdue = await this.prisma.$queryRaw<{ userId: string; count: Num }[]>`
      SELECT f."ownerUserId" AS "userId", COUNT(*) AS "count"
        FROM "CrmFollowUp" f JOIN "CrmLead" l ON l."id" = f."leadId"
       WHERE f."status" = 'OPEN' AND f."dueAt" < now() AND ${where}
       GROUP BY 1`;
    const ids = [
      ...new Set([
        ...leadRows.map((r) => r.key).filter((x): x is string => !!x),
        ...acts.map((a) => a.userId),
        ...moves.map((m) => m.userId).filter(Boolean),
        ...overdue.map((o) => o.userId),
      ]),
    ];
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, fullName: true },
    });
    const name = new Map(users.map((u) => [u.id, u.fullName]));
    const keys = [...ids, ...(leadRows.some((r) => r.key === null) ? [null] : [])];
    return {
      window: { from: from.toISOString(), to: to.toISOString() },
      note: 'Activities are outreach people logged. The platform sends nothing.',
      rows: keys.map((id) => {
        const leads = leadRows.find((r) => r.key === id);
        const byType = Object.fromEntries(
          CRM_ACTIVITY_TYPES.map((t) => [
            t,
            n(acts.find((a) => a.userId === id && a.type === t)?.count),
          ]),
        );
        return {
          userId: id,
          name: id ? (name.get(id) ?? 'Former staff') : 'Unassigned',
          leads: leads ?? null,
          activitiesLogged: Object.values(byType).reduce((a, b) => a + b, 0),
          activitiesByType: byType,
          stageMoves: n(moves.find((m) => m.userId === id)?.count),
          overdueFollowUps: n(overdue.find((o) => o.userId === id)?.count),
        };
      }),
    };
  }

  async activity(actor: RequestUser, q: CrmReportQuery) {
    const scope = await this.scopes.resolve(actor);
    const bucket = q.bucket === 'month' ? 'month' : 'week';
    const { from, to } = this.window(q, bucket === 'month' ? 365 : 84);
    const where = this.where(scope, q, { cohort: false });
    const rows = await this.prisma.$queryRaw<{ period: Date; type: string; count: Num }[]>`
      SELECT date_trunc(${bucket}, a."occurredAt") AS "period", a."type"::text AS "type", COUNT(*) AS "count"
        FROM "CrmActivity" a JOIN "CrmLead" l ON l."id" = a."leadId"
       WHERE a."occurredAt" >= ${from} AND a."occurredAt" < ${to} AND ${where}
       GROUP BY 1, 2
       ORDER BY 1 ASC`;
    const periods = [...new Set(rows.map((r) => r.period.toISOString()))];
    return {
      bucket,
      window: { from: from.toISOString(), to: to.toISOString() },
      note: 'Logged outreach, counted by when it happened. Nothing here was sent by the platform.',
      rows: periods.map((p) => {
        const byType = Object.fromEntries(
          CRM_ACTIVITY_TYPES.map((t) => [
            t,
            n(rows.find((r) => r.period.toISOString() === p && r.type === t)?.count),
          ]),
        );
        return { period: p, total: Object.values(byType).reduce((a, b) => a + b, 0), ...byType };
      }),
    };
  }

  async aging(actor: RequestUser, q: CrmReportQuery) {
    const scope = await this.scopes.resolve(actor);
    const rows = await this.prisma.$queryRaw<
      { stage: string; count: Num; avgDays: number | null; maxDays: number | null; over30: Num }[]
    >`
      SELECT l."stage"::text AS "stage", COUNT(*) AS "count",
             AVG(EXTRACT(EPOCH FROM (now() - l."stageChangedAt")) / 86400)::float8 AS "avgDays",
             MAX(EXTRACT(EPOCH FROM (now() - l."stageChangedAt")) / 86400)::float8 AS "maxDays",
             COUNT(*) FILTER (WHERE l."stageChangedAt" < now() - interval '30 days') AS "over30"
        FROM "CrmLead" l
       WHERE ${this.where(scope, q, { cohort: true })}
       GROUP BY 1`;
    return {
      definition: 'Days since each lead entered the stage it is in now.',
      rows: CRM_STAGES.map((s) => {
        const r = rows.find((x) => x.stage === s);
        const count = n(r?.count);
        return {
          stage: s,
          count,
          avgDays: r?.avgDays != null ? Math.round(r.avgDays * 10) / 10 : null,
          maxDays: r?.maxDays != null ? Math.floor(r.maxDays) : null,
          over30Days: ratio(n(r?.over30), count),
        };
      }),
    };
  }

  /** Onboarding and first-event conversion, from the platform's own records. */
  async conversion(actor: RequestUser, q: CrmReportQuery) {
    const scope = await this.scopes.resolve(actor);
    const [row] = await this.prisma.$queryRaw<Record<string, Num | number | null>[]>`
      SELECT COUNT(*) FILTER (WHERE mx."maxIdx" >= ${stageIdx('ONBOARDING')}) AS "reachedOnboarding",
             COUNT(*) FILTER (WHERE mx."maxIdx" >= ${stageIdx('ONBOARDING')} AND l."organizationId" IS NOT NULL) AS "onboardingLinked",
             COUNT(*) FILTER (WHERE mx."maxIdx" >= ${stageIdx('ONBOARDING')} AND o."status" = 'APPROVED') AS "onboardingApproved",
             COUNT(*) FILTER (WHERE l."organizationId" IS NOT NULL) AS "linked",
             COUNT(*) FILTER (WHERE o."status" = 'APPROVED') AS "approved",
             COUNT(*) FILTER (WHERE o."status" = 'APPROVED' AND fe."firstAt" IS NOT NULL) AS "firstEvent",
             COUNT(*) FILTER (WHERE l."stage" = 'ACTIVATED') AS "manualActivated",
             COUNT(*) FILTER (WHERE l."stage" = 'ACTIVATED' AND (o."status" IS DISTINCT FROM 'APPROVED')) AS "manualNotDerived",
             (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY GREATEST(0, EXTRACT(EPOCH FROM (fe."firstAt" - l."linkedAt")) / 86400))
               FILTER (WHERE fe."firstAt" IS NOT NULL AND l."linkedAt" IS NOT NULL))::float8 AS "medianDaysLinkToFirstEvent"
        ${this.from}
       WHERE ${this.where(scope, q, { cohort: true })}`;
    const v = (k: string) => n(row?.[k] as Num);
    const median = row?.medianDaysLinkToFirstEvent as number | null | undefined;
    return {
      onboarding: {
        reached: v('reachedOnboarding'),
        linked: ratio(v('onboardingLinked'), v('reachedOnboarding')),
        approved: ratio(v('onboardingApproved'), v('reachedOnboarding')),
      },
      firstEvent: {
        linked: v('linked'),
        approved: ratio(v('approved'), v('linked')),
        withFirstPublishedEvent: ratio(v('firstEvent'), v('approved')),
        medianDaysFromLinkToFirstEvent: median != null ? Math.round(median * 10) / 10 : null,
      },
      manualStage: {
        activated: v('manualActivated'),
        /** Marked Activated by a person but not approved now (e.g. the organizer was suspended). */
        activatedButNotApprovedNow: v('manualNotDerived'),
      },
    };
  }

  // ── CSV ─────────────────────────────────────────────────────────────────────

  async csv(actor: RequestUser, report: string, q: CrmReportQuery): Promise<string> {
    const r = (x: Ratio) => [x.numerator, x.denominator] as CsvValue[];
    const pair = (label: string) => [label, `${label} of`];
    const groupHeaders = [
      'Total',
      ...pair('Contacted'),
      ...pair('Interested'),
      ...pair('Demo completed'),
      ...pair('Onboarding'),
      ...pair('Lost'),
      ...pair('Linked to organizer'),
      ...pair('Activated (organizer approved)'),
      ...pair('With first published event'),
    ];
    type G = Awaited<ReturnType<CrmReportsService['grouped']>>[number];
    const groupCells = (g: G): CsvValue[] => [
      g.total,
      ...r(g.contacted),
      ...r(g.interested),
      ...r(g.demoCompleted),
      ...r(g.onboarding),
      ...r(g.lost),
      ...r(g.linked),
      ...r(g.activated),
      ...r(g.firstEvent),
    ];
    switch (report) {
      case 'funnel': {
        const f = await this.funnel(actor, q);
        return toCsv(
          ['Stage', 'Leads that reached it', 'Of leads in cohort'],
          f.stages.map((s) => [s.stage, s.reached, s.ofCohort.denominator]),
        );
      }
      case 'by-country':
        return toCsv(
          ['Country', ...groupHeaders],
          (await this.byCountry(actor, q)).rows.map((g) => [g.key, ...groupCells(g)]),
        );
      case 'by-source':
        return toCsv(
          ['Source', ...groupHeaders],
          (await this.bySource(actor, q)).rows.map((g) => [g.key, ...groupCells(g)]),
        );
      case 'by-employee': {
        const e = await this.byEmployee(actor, q);
        return toCsv(
          [
            'Person',
            'Leads assigned',
            'Activities logged (not sent)',
            ...CRM_ACTIVITY_TYPES.map((t) => `${t} logged`),
            'Stage moves',
            'Overdue follow-ups',
          ],
          e.rows.map((x) => [
            x.name,
            x.leads?.total ?? 0,
            x.activitiesLogged,
            ...CRM_ACTIVITY_TYPES.map((t) => x.activitiesByType[t]),
            x.stageMoves,
            x.overdueFollowUps,
          ]),
        );
      }
      case 'activity': {
        const a = await this.activity(actor, q);
        return toCsv(
          ['Period start (UTC)', 'Logged activities', ...CRM_ACTIVITY_TYPES],
          a.rows.map((x) => [
            x.period.slice(0, 10),
            x.total,
            ...CRM_ACTIVITY_TYPES.map((t) => (x as unknown as Record<string, number>)[t]),
          ]),
        );
      }
      case 'aging': {
        const a = await this.aging(actor, q);
        return toCsv(
          ['Stage', 'Leads', 'Average days in stage', 'Longest days in stage', 'Over 30 days'],
          a.rows.map((x) => [x.stage, x.count, x.avgDays, x.maxDays, x.over30Days.numerator]),
        );
      }
      default:
        return '';
    }
  }
}
