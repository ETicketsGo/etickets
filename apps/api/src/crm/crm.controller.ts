import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { AdminPermission, Role, type CrmTeamRole } from '@eticketsgo/shared-types';
import {
  crmActivityListQuerySchema,
  crmActivitySchema,
  crmArchiveSchema,
  crmAssignSchema,
  crmCancelFollowUpSchema,
  crmCompleteFollowUpSchema,
  crmCreateLeadSchema,
  crmCreateTeamSchema,
  crmDuplicateCheckSchema,
  crmFollowUpInputSchema,
  crmFollowUpListQuerySchema,
  crmImportSchema,
  crmLeadListQuerySchema,
  crmLinkOrganizationSchema,
  crmOrganizationSearchSchema,
  crmReassignFollowUpSchema,
  crmReportQuerySchema,
  crmStageSchema,
  crmTeamMemberSchema,
  crmUnlinkOrganizationSchema,
  crmUpdateLeadSchema,
  type CrmReportQuery,
} from '@eticketsgo/validation';
import {
  CurrentUser,
  RequiresAdmin,
  RequiresRecentMfa,
  Roles,
  type RequestUser,
} from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AppException, ErrorCodes } from '../common/errors';
import { CrmLeadsService } from './crm-leads.service';
import { CrmActivitiesService } from './crm-activities.service';
import { CrmImportService } from './crm-import.service';
import { CrmTeamsService } from './crm-teams.service';
import { CrmReportsService } from './crm-reports.service';

/*
  Not called `Body`: decorator metadata emits a parameter's TYPE name as a runtime value, and a
  type alias named like the `@Body` decorator made Nest hand the global ValidationPipe the
  decorator function itself as the payload ("Expected object, received function").
*/
type Payload<S extends z.ZodTypeAny> = z.infer<S>;

/** The pipe for a schema whose input differs from its output (defaults, transforms). */
const pipe = <S extends z.ZodTypeAny>(schema: S) =>
  new ZodValidationPipe<z.output<S>>(schema as unknown as z.ZodType<z.output<S>>);

/*
  ── WHO CAN CALL WHAT ────────────────────────────────────────────────────────────────
  Every route: a back-office account (ADMIN / SUPER_ADMIN role) holding CRM_AGENT. Routes that
  run a team - assigning, reopening, linking organizations, importing, exporting, reports -
  also need CRM_MANAGER (both, never either). Inside, CrmScopeService narrows each request to
  the caller's teams, so the capability opens the door and the team decides which room.

  CRM_AGENT and CRM_MANAGER open nothing outside /admin/crm. See
  crm-boundary.http.integration-postgres.spec.ts, which calls the sensitive admin surface with
  an agent-only account and expects every request refused.
*/
const MANAGER = [AdminPermission.CRM_AGENT, AdminPermission.CRM_MANAGER] as const;

@ApiTags('admin-crm')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.CRM_AGENT)
@Controller('admin/crm')
export class CrmController {
  constructor(
    private readonly leads: CrmLeadsService,
    private readonly activities: CrmActivitiesService,
    private readonly importer: CrmImportService,
    private readonly teams: CrmTeamsService,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'My acquisition teams and what I can do in each.' })
  me(@CurrentUser() actor: RequestUser) {
    return this.teams.me(actor);
  }

  // ── Leads ──────────────────────────────────────────────────────────────────

  @Get('leads')
  @ApiOperation({ summary: 'Leads in my scope: filtered, searched, paginated on the server.' })
  list(
    @CurrentUser() actor: RequestUser,
    @Query(pipe(crmLeadListQuerySchema)) q: Payload<typeof crmLeadListQuerySchema>,
  ) {
    return this.leads.list(actor, q);
  }

  @Post('leads')
  @ApiOperation({
    summary: 'Add a prospect. Refused with the matches when it looks like a duplicate.',
  })
  create(
    @CurrentUser() actor: RequestUser,
    @Body(pipe(crmCreateLeadSchema)) body: Payload<typeof crmCreateLeadSchema>,
  ) {
    return this.leads.create(actor, body);
  }

  @Post('leads/duplicates')
  @ApiOperation({ summary: 'Check typed details against every lead. Writes nothing.' })
  duplicates(
    @CurrentUser() actor: RequestUser,
    @Body(pipe(crmDuplicateCheckSchema)) body: Payload<typeof crmDuplicateCheckSchema>,
  ) {
    return this.leads.checkDuplicates(actor, body);
  }

  @Get('leads/export')
  @RequiresAdmin(...MANAGER)
  @ApiOperation({ summary: 'CSV of the filtered leads in the teams I manage (manager).' })
  async export(
    @CurrentUser() actor: RequestUser,
    @Query(pipe(crmLeadListQuerySchema)) q: Payload<typeof crmLeadListQuerySchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const csv = await this.leads.exportCsv(actor, q);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="prospects-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    return csv;
  }

  @Post('leads/import')
  @RequiresAdmin(...MANAGER)
  @ApiOperation({ summary: 'Preview, then commit, a CSV of prospects into one team (manager).' })
  import(
    @CurrentUser() actor: RequestUser,
    @Body(pipe(crmImportSchema)) body: Payload<typeof crmImportSchema>,
  ) {
    return this.importer.run(actor, body);
  }

  @Get('leads/:id')
  @ApiOperation({
    summary: 'One lead with its history, activities, follow-ups and derived activation.',
  })
  detail(@CurrentUser() actor: RequestUser, @Param('id') id: string) {
    return this.leads.detail(actor, id);
  }

  @Patch('leads/:id')
  @ApiOperation({ summary: 'Edit a lead (names the version it read).' })
  update(
    @CurrentUser() actor: RequestUser,
    @Param('id') id: string,
    @Body(pipe(crmUpdateLeadSchema)) body: Payload<typeof crmUpdateLeadSchema>,
  ) {
    return this.leads.update(actor, id, body);
  }

  @Post('leads/:id/assign')
  @RequiresAdmin(...MANAGER)
  @ApiOperation({ summary: 'Assign or reassign a lead (manager).' })
  assign(
    @CurrentUser() actor: RequestUser,
    @Param('id') id: string,
    @Body(pipe(crmAssignSchema)) body: Payload<typeof crmAssignSchema>,
  ) {
    return this.leads.assign(actor, id, body);
  }

  @Post('leads/:id/stage')
  @ApiOperation({ summary: 'Move a lead along the pipeline (controlled transitions).' })
  stage(
    @CurrentUser() actor: RequestUser,
    @Param('id') id: string,
    @Body(pipe(crmStageSchema)) body: Payload<typeof crmStageSchema>,
  ) {
    return this.leads.changeStage(actor, id, body);
  }

  @Post('leads/:id/archive')
  @RequiresAdmin(...MANAGER)
  @ApiOperation({ summary: 'Archive or restore a lead (manager).' })
  archive(
    @CurrentUser() actor: RequestUser,
    @Param('id') id: string,
    @Body(pipe(crmArchiveSchema)) body: Payload<typeof crmArchiveSchema>,
  ) {
    return this.leads.archive(actor, id, body);
  }

  @Get('organizations')
  @RequiresAdmin(...MANAGER)
  @ApiOperation({ summary: 'Find an EXISTING organization to link a lead to (manager).' })
  organizations(
    @CurrentUser() actor: RequestUser,
    @Query(pipe(crmOrganizationSearchSchema)) q: { q: string },
  ) {
    return this.leads.searchOrganizations(actor, q.q);
  }

  @Post('leads/:id/organization')
  @RequiresAdmin(...MANAGER)
  @ApiOperation({
    summary: 'Link a lead to an existing organization. Never creates one (manager).',
  })
  link(
    @CurrentUser() actor: RequestUser,
    @Param('id') id: string,
    @Body(pipe(crmLinkOrganizationSchema)) body: Payload<typeof crmLinkOrganizationSchema>,
  ) {
    return this.leads.linkOrganization(actor, id, body);
  }

  @Post('leads/:id/organization/unlink')
  @RequiresAdmin(...MANAGER)
  @ApiOperation({ summary: 'Remove the link to an organization (manager).' })
  unlink(
    @CurrentUser() actor: RequestUser,
    @Param('id') id: string,
    @Body(pipe(crmUnlinkOrganizationSchema))
    body: Payload<typeof crmUnlinkOrganizationSchema>,
  ) {
    return this.leads.unlinkOrganization(actor, id, body);
  }

  // ── Activities and follow-ups ───────────────────────────────────────────────

  @Post('leads/:id/activities')
  @ApiOperation({ summary: 'Log outreach that already happened. Sends nothing.' })
  logActivity(
    @CurrentUser() actor: RequestUser,
    @Param('id') id: string,
    @Body(pipe(crmActivitySchema)) body: Payload<typeof crmActivitySchema>,
  ) {
    return this.activities.log(actor, id, body);
  }

  @Post('leads/:id/follow-ups')
  @ApiOperation({ summary: 'Schedule a follow-up on a lead.' })
  createFollowUp(
    @CurrentUser() actor: RequestUser,
    @Param('id') id: string,
    @Body(pipe(crmFollowUpInputSchema)) body: Payload<typeof crmFollowUpInputSchema>,
  ) {
    return this.activities.createFollowUp(actor, id, body);
  }

  @Get('activities')
  @ApiOperation({ summary: 'Logged activities in my scope, newest first.' })
  listActivities(
    @CurrentUser() actor: RequestUser,
    @Query(pipe(crmActivityListQuerySchema))
    q: Payload<typeof crmActivityListQuerySchema>,
  ) {
    return this.activities.listActivities(actor, q);
  }

  @Get('follow-ups')
  @ApiOperation({ summary: 'Follow-ups in my scope: overdue, due soon, upcoming or done.' })
  listFollowUps(
    @CurrentUser() actor: RequestUser,
    @Query(pipe(crmFollowUpListQuerySchema))
    q: Payload<typeof crmFollowUpListQuerySchema>,
  ) {
    return this.activities.listFollowUps(actor, q);
  }

  @Post('follow-ups/:id/complete')
  @ApiOperation({ summary: 'Mark a follow-up done.' })
  complete(
    @CurrentUser() actor: RequestUser,
    @Param('id') id: string,
    @Body(pipe(crmCompleteFollowUpSchema)) body: Payload<typeof crmCompleteFollowUpSchema>,
  ) {
    return this.activities.close(actor, id, body, 'DONE');
  }

  @Post('follow-ups/:id/cancel')
  @ApiOperation({ summary: 'Cancel a follow-up.' })
  cancel(
    @CurrentUser() actor: RequestUser,
    @Param('id') id: string,
    @Body(pipe(crmCancelFollowUpSchema)) body: Payload<typeof crmCancelFollowUpSchema>,
  ) {
    return this.activities.close(actor, id, body, 'CANCELLED');
  }

  @Post('follow-ups/:id/reassign')
  @RequiresAdmin(...MANAGER)
  @ApiOperation({ summary: 'Give a follow-up to somebody else on the team (manager).' })
  reassignFollowUp(
    @CurrentUser() actor: RequestUser,
    @Param('id') id: string,
    @Body(pipe(crmReassignFollowUpSchema)) body: Payload<typeof crmReassignFollowUpSchema>,
  ) {
    return this.activities.reassign(actor, id, body);
  }
}

/** Acquisition teams: scope, never capability. */
@ApiTags('admin-crm')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.CRM_AGENT)
@Controller('admin/crm/teams')
export class CrmTeamsController {
  constructor(private readonly teams: CrmTeamsService) {}

  @Get()
  @ApiOperation({ summary: 'My teams; members are listed for teams I manage.' })
  list(@CurrentUser() actor: RequestUser) {
    return this.teams.list(actor);
  }

  @Post()
  @RequiresAdmin(...MANAGER)
  @RequiresRecentMfa()
  @ApiOperation({ summary: 'Create an acquisition team for a country (super admin).' })
  create(
    @CurrentUser() actor: RequestUser,
    @Body(pipe(crmCreateTeamSchema)) body: Payload<typeof crmCreateTeamSchema>,
  ) {
    return this.teams.createTeam(actor, body);
  }

  @Get(':teamId/candidates')
  @RequiresAdmin(...MANAGER)
  @ApiOperation({
    summary: 'Staff with the Acquisition agent duty who are not on this team (manager).',
  })
  candidates(@CurrentUser() actor: RequestUser, @Param('teamId') teamId: string) {
    return this.teams.candidates(actor, teamId);
  }

  @Put(':teamId/members/:userId')
  @RequiresAdmin(...MANAGER)
  @RequiresRecentMfa()
  @ApiOperation({ summary: 'Add somebody to a team, or change their role in it (manager).' })
  setMember(
    @CurrentUser() actor: RequestUser,
    @Param('teamId') teamId: string,
    @Param('userId') userId: string,
    @Body(pipe(crmTeamMemberSchema.omit({ userId: true })))
    body: { role: CrmTeamRole },
  ) {
    return this.teams.setMember(actor, teamId, userId, body.role);
  }

  @Delete(':teamId/members/:userId')
  @RequiresAdmin(...MANAGER)
  @RequiresRecentMfa()
  @ApiOperation({ summary: 'Take somebody off a team (manager).' })
  removeMember(
    @CurrentUser() actor: RequestUser,
    @Param('teamId') teamId: string,
    @Param('userId') userId: string,
  ) {
    return this.teams.removeMember(actor, teamId, userId);
  }
}

const REPORTS = [
  'funnel',
  'by-country',
  'by-source',
  'by-employee',
  'activity',
  'aging',
  'conversion',
] as const;
const CSV_REPORTS = new Set([
  'funnel',
  'by-country',
  'by-source',
  'by-employee',
  'activity',
  'aging',
]);

/** Acquisition dashboards and reports, aggregated on the server over the caller's scope. */
@ApiTags('admin-crm')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.CRM_AGENT)
@Controller('admin/crm/reports')
export class CrmReportsController {
  constructor(private readonly reports: CrmReportsService) {}

  @Get('overview')
  @ApiOperation({ summary: 'KPI cards. An agent sees their own leads, a manager their teams.' })
  overview(
    @CurrentUser() actor: RequestUser,
    @Query(pipe(crmReportQuerySchema)) q: CrmReportQuery,
  ) {
    return this.reports.overview(actor, q);
  }

  @Get(':report')
  @RequiresAdmin(...MANAGER)
  @ApiOperation({ summary: 'A team report as JSON, or CSV with ?format=csv (manager).' })
  async report(
    @CurrentUser() actor: RequestUser,
    @Param('report') report: string,
    @Query(pipe(crmReportQuerySchema)) q: CrmReportQuery,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!(REPORTS as readonly string[]).includes(report)) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'No such report.', HttpStatus.NOT_FOUND);
    }
    if (q.format === 'csv') {
      if (!CSV_REPORTS.has(report)) {
        throw new AppException(
          ErrorCodes.VALIDATION_FAILED,
          'That report has no CSV export.',
          HttpStatus.BAD_REQUEST,
        );
      }
      const csv = await this.reports.csv(actor, report, q);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="acquisition-${report}.csv"`);
      return csv;
    }
    switch (report as (typeof REPORTS)[number]) {
      case 'funnel':
        return this.reports.funnel(actor, q);
      case 'by-country':
        return this.reports.byCountry(actor, q);
      case 'by-source':
        return this.reports.bySource(actor, q);
      case 'by-employee':
        return this.reports.byEmployee(actor, q);
      case 'activity':
        return this.reports.activity(actor, q);
      case 'aging':
        return this.reports.aging(actor, q);
      case 'conversion':
        return this.reports.conversion(actor, q);
    }
  }
}
