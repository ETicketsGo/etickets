import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Ip,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { z } from 'zod';
import { AdminPermission, EntitlementKey, Role } from '@eticketsgo/shared-types';
import {
  CurrentUser,
  Public,
  RequiresAdmin,
  RequiresRecentMfa,
  Roles,
  type RequestUser,
} from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ConfigService } from '@nestjs/config';
import { RequiresEntitlement } from '../billing/entitlements/requires-entitlement';
import { OrganizerOnly } from '../tenancy/organizer-only.guard';
import { redirectUrl } from '../common/console-urls';
import { CampaignsService } from './campaigns.service';
import { CampaignAnalyticsService } from './campaign-analytics.service';
import { CampaignEventsService } from './campaign-events.service';
import { CampaignAdminService } from './campaign-admin.service';
import {
  adminListSchema,
  adminPauseSchema,
  analyticsQuerySchema,
  audiencePreviewSchema,
  draftSchema,
  listSchema,
  pageSchema,
  rescheduleSchema,
  scheduleSchema,
  segmentSchema,
  sendSchema,
  statsQuerySchema,
  testSendSchema,
  updateSchema,
  versionSchema,
} from './campaigns.schemas';
import type { CampaignStatus } from './campaign-state';

/*
  Not called `Body`: decorator metadata emits a parameter's TYPE name as a runtime value (see
  crm.controller.ts for the defect that taught this).
*/
type Payload<S extends z.ZodTypeAny> = z.output<S>;
const pipe = <S extends z.ZodTypeAny>(schema: S) =>
  new ZodValidationPipe<z.output<S>>(schema as unknown as z.ZodType<z.output<S>>);

const MANAGERS = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER];
const CREATE = EntitlementKey.CAMPAIGNS_CREATE;

/*
  ── WHO CAN CALL WHAT ────────────────────────────────────────────────────────────────
  Owners and managers of the organization in the route, with the plan entitlement on the
  route (EntitlementGuard: membership first, then the plan) and again in the service. Staff who
  are not members are refused here (ORGANIZER_ROUTE_POLICY: NONE); they oversee campaigns on
  /admin/campaigns. Sending, scheduling and test sends are the organization's own decision to
  mail people under its name, so staff are refused at the door (@OrganizerOnly). `status` needs membership only, so the console can explain a missing plan.

  Static paths come BEFORE `:campaignId`: Nest matches routes in the order they are declared.
*/
@ApiTags('organizations')
@ApiBearerAuth()
@Controller('organizations/:id/campaigns')
export class OrganizerCampaignsController {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly analytics: CampaignAnalyticsService,
  ) {}

  @Get('status')
  @ApiOperation({ summary: 'Whether campaigns are on, the plan, the quota and the templates.' })
  status(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.campaigns.status(user, id);
  }

  @Get()
  @RequiresEntitlement(CREATE, { roles: MANAGERS })
  list(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query(pipe(listSchema)) q: Payload<typeof listSchema>,
  ) {
    return this.campaigns.list(user, id, {
      status: q.status as CampaignStatus | undefined,
      page: q.page,
      pageSize: q.pageSize,
    });
  }

  @Post()
  @RequiresEntitlement(CREATE, { roles: MANAGERS })
  create(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(pipe(draftSchema)) body: Payload<typeof draftSchema>,
  ) {
    return this.campaigns.create(user, id, body);
  }

  @Post('audience-preview')
  @HttpCode(200)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @RequiresEntitlement(CREATE, { roles: MANAGERS })
  @ApiOperation({ summary: 'How many people an audience reaches. Counts only.' })
  audiencePreview(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(pipe(audiencePreviewSchema)) body: Payload<typeof audiencePreviewSchema>,
  ) {
    return this.campaigns.previewAudience(user, id, body);
  }

  @Get('segments')
  @RequiresEntitlement(CREATE, { roles: MANAGERS })
  segments(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.campaigns.segments(user, id);
  }

  @Post('segments')
  @RequiresEntitlement(EntitlementKey.AUDIENCE_ADVANCED, { roles: MANAGERS })
  createSegment(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(pipe(segmentSchema)) body: Payload<typeof segmentSchema>,
  ) {
    return this.campaigns.createSegment(user, id, body);
  }

  @Delete('segments/:segmentId')
  @RequiresEntitlement(CREATE, { roles: MANAGERS })
  deleteSegment(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('segmentId') segmentId: string,
  ) {
    return this.campaigns.deleteSegment(user, id, segmentId);
  }

  @Get('analytics')
  @RequiresEntitlement(EntitlementKey.CAMPAIGNS_ANALYTICS_BASIC, { roles: MANAGERS })
  @ApiOperation({ summary: 'Audience and campaign results over a date range. Aggregates only.' })
  overview(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query(pipe(analyticsQuerySchema)) q: Payload<typeof analyticsQuerySchema>,
  ) {
    return this.analytics.overview(user, id, q);
  }

  @Get('analytics/export')
  @RequiresEntitlement(EntitlementKey.CAMPAIGNS_ANALYTICS_BASIC, { roles: MANAGERS })
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="audience-and-campaigns.csv"')
  @ApiOperation({ summary: 'The same figures as CSV. Aggregates only, never a row per person.' })
  exportCsv(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query(pipe(analyticsQuerySchema)) q: Payload<typeof analyticsQuerySchema>,
  ) {
    return this.analytics.exportCsv(user, id, q);
  }

  @Get(':campaignId')
  @RequiresEntitlement(CREATE, { roles: MANAGERS })
  get(@CurrentUser() user: RequestUser, @Param('id') id: string, @Param('campaignId') cid: string) {
    return this.campaigns.get(user, id, cid);
  }

  @Patch(':campaignId')
  @RequiresEntitlement(CREATE, { roles: MANAGERS })
  update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('campaignId') cid: string,
    @Body(pipe(updateSchema)) body: Payload<typeof updateSchema>,
  ) {
    return this.campaigns.update(user, id, cid, body);
  }

  @Post(':campaignId/duplicate')
  @RequiresEntitlement(CREATE, { roles: MANAGERS })
  duplicate(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('campaignId') cid: string,
  ) {
    return this.campaigns.duplicate(user, id, cid);
  }

  @Get(':campaignId/audience')
  @RequiresEntitlement(CREATE, { roles: MANAGERS })
  campaignAudience(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('campaignId') cid: string,
  ) {
    return this.campaigns.campaignAudience(user, id, cid);
  }

  @Get(':campaignId/preview')
  @RequiresEntitlement(CREATE, { roles: MANAGERS })
  @ApiOperation({ summary: 'The rendered email, for a sandboxed iframe. Links are not tracked.' })
  preview(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('campaignId') cid: string,
  ) {
    return this.campaigns.preview(user, id, cid);
  }

  @Post(':campaignId/test-send')
  @OrganizerOnly('campaigns.test-send')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequiresEntitlement(CREATE, { roles: MANAGERS })
  @ApiOperation({ summary: 'Send a test to your own or a team member’s verified address.' })
  testSend(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('campaignId') cid: string,
    @Body(pipe(testSendSchema)) body: Payload<typeof testSendSchema>,
  ) {
    return this.campaigns.testSend(user, id, cid, body);
  }

  @Post(':campaignId/review')
  @HttpCode(200)
  @RequiresEntitlement(CREATE, { roles: MANAGERS })
  @ApiOperation({ summary: 'Final checks. Returns the confirmation token send and schedule need.' })
  review(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('campaignId') cid: string,
  ) {
    return this.campaigns.review(user, id, cid);
  }

  @Post(':campaignId/schedule')
  @OrganizerOnly('campaigns.schedule')
  @HttpCode(200)
  @RequiresEntitlement(EntitlementKey.CAMPAIGNS_SCHEDULE, { roles: MANAGERS })
  schedule(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('campaignId') cid: string,
    @Body(pipe(scheduleSchema)) body: Payload<typeof scheduleSchema>,
  ) {
    return this.campaigns.schedule(user, id, cid, body);
  }

  @Post(':campaignId/reschedule')
  @HttpCode(200)
  @RequiresEntitlement(EntitlementKey.CAMPAIGNS_SCHEDULE, { roles: MANAGERS })
  reschedule(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('campaignId') cid: string,
    @Body(pipe(rescheduleSchema)) body: Payload<typeof rescheduleSchema>,
  ) {
    return this.campaigns.reschedule(user, id, cid, body);
  }

  @Post(':campaignId/unschedule')
  @HttpCode(200)
  @RequiresEntitlement(CREATE, { roles: MANAGERS })
  unschedule(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('campaignId') cid: string,
    @Body(pipe(versionSchema)) body: Payload<typeof versionSchema>,
  ) {
    return this.campaigns.unschedule(user, id, cid, body.version);
  }

  @Post(':campaignId/send')
  @OrganizerOnly('campaigns.send')
  @HttpCode(200)
  @RequiresEntitlement(CREATE, { roles: MANAGERS })
  @ApiOperation({ summary: 'Send now. Needs the confirmation token from the review step.' })
  send(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('campaignId') cid: string,
    @Body(pipe(sendSchema)) body: Payload<typeof sendSchema>,
  ) {
    return this.campaigns.sendNow(user, id, cid, body);
  }

  @Post(':campaignId/cancel')
  @HttpCode(200)
  @RequiresEntitlement(CREATE, { roles: MANAGERS })
  cancel(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('campaignId') cid: string,
    @Body(pipe(versionSchema)) body: Payload<typeof versionSchema>,
  ) {
    return this.campaigns.cancel(user, id, cid, body.version);
  }

  @Post(':campaignId/pause')
  @HttpCode(200)
  @RequiresEntitlement(CREATE, { roles: MANAGERS })
  pause(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('campaignId') cid: string,
    @Body(pipe(versionSchema)) body: Payload<typeof versionSchema>,
  ) {
    return this.campaigns.pause(user, id, cid, body.version);
  }

  @Post(':campaignId/resume')
  @HttpCode(200)
  @RequiresEntitlement(CREATE, { roles: MANAGERS })
  resume(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('campaignId') cid: string,
    @Body(pipe(versionSchema)) body: Payload<typeof versionSchema>,
  ) {
    return this.campaigns.resume(user, id, cid, body.version);
  }

  @Get(':campaignId/history')
  @RequiresEntitlement(CREATE, { roles: MANAGERS })
  history(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('campaignId') cid: string,
    @Query(pipe(pageSchema)) q: Payload<typeof pageSchema>,
  ) {
    return this.campaigns.historyFor(user, id, cid, q);
  }

  @Get(':campaignId/stats')
  @RequiresEntitlement(EntitlementKey.CAMPAIGNS_ANALYTICS_BASIC, { roles: MANAGERS })
  stats(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('campaignId') cid: string,
    @Query(pipe(statsQuerySchema)) q: Payload<typeof statsQuerySchema>,
  ) {
    return this.analytics.campaignStats(user, id, cid, q);
  }
}

/**
 * The tracked link in a campaign email. No sign-in: the signature is the authority, and all it
 * can do is record one click and redirect to a page this platform owns.
 */
@ApiTags('public')
@Controller('public/campaign-links')
export class PublicCampaignLinksController {
  constructor(
    private readonly events: CampaignEventsService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @SkipThrottle()
  @Get(':token')
  @ApiOperation({ summary: 'Record a campaign click and redirect to an ETicketsGo page.' })
  async go(@Param('token') token: string, @Res() res: Response): Promise<void> {
    const target = await this.events.click(token);
    let home: string;
    try {
      home = redirectUrl(this.config, {
        site: 'customer',
        path: '/',
        purpose: 'campaign link fallback',
      });
    } catch {
      home = '/';
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(302, target ?? home);
  }
}

/*
  Platform oversight. Reading is ORGANIZER_READ (it is a view of what organizers do); the brake
  is ORGANIZER_REVIEW, the capability that already approves or refuses an organizer, with a
  fresh second factor. No route here returns a recipient or an address.
*/
@ApiTags('admin-campaigns')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@RequiresAdmin(AdminPermission.ORGANIZER_READ)
@Controller('admin/campaigns')
export class AdminCampaignsController {
  constructor(private readonly admin: CampaignAdminService) {}

  @Get()
  @ApiOperation({ summary: 'Campaigns across organizers. No recipients.' })
  list(@Query(pipe(adminListSchema)) q: Payload<typeof adminListSchema>) {
    return this.admin.list(q);
  }

  @Get('health')
  @ApiOperation({ summary: 'Bounce and complaint rates of campaign mail.' })
  health() {
    return this.admin.health();
  }

  @Post(':campaignId/pause')
  @HttpCode(200)
  @RequiresAdmin(AdminPermission.ORGANIZER_REVIEW)
  @RequiresRecentMfa()
  @ApiOperation({ summary: 'Stop a campaign. Audited. Only staff can resume it.' })
  pause(
    @CurrentUser() actor: RequestUser,
    @Param('campaignId') campaignId: string,
    @Body(pipe(adminPauseSchema)) body: Payload<typeof adminPauseSchema>,
    @Ip() ip: string,
  ) {
    return this.admin.pause(actor.id, campaignId, body.reason, ip);
  }

  @Post(':campaignId/release')
  @HttpCode(200)
  @RequiresAdmin(AdminPermission.ORGANIZER_REVIEW)
  @RequiresRecentMfa()
  @ApiOperation({ summary: 'Lift a staff pause. Audited.' })
  release(
    @CurrentUser() actor: RequestUser,
    @Param('campaignId') campaignId: string,
    @Ip() ip: string,
  ) {
    return this.admin.release(actor.id, campaignId, ip);
  }
}
