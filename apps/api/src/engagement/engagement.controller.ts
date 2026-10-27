import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { policyJurisdictionFor } from '@eticketsgo/shared-types';
import { CurrentUser, Public, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AppException, ErrorCodes } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { OrganizerFollowService, FOLLOW_SOURCES } from './organizer-follow.service';
import { CommunicationConsentService } from './communication-consent.service';
import { UnsubscribeService } from './unsubscribe.service';
import { AudienceSummaryService } from './audience-summary.service';
import { ConsentPurpose, ORGANIZER_PURPOSES } from './consent-purpose';

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

const followSchema = z
  .object({ source: z.enum(FOLLOW_SOURCES).default('ORGANIZER_PAGE') })
  .default({ source: 'ORGANIZER_PAGE' });

const preferencesSchema = z
  .object({
    newEvents: z.boolean().optional(),
    earlyAccess: z.boolean().optional(),
    offers: z.boolean().optional(),
    emailUpdates: z.boolean().optional(),
    cadence: z.enum(['INSTANT', 'WEEKLY_DIGEST']).optional(),
    /** The market whose wording was shown. Only picks the policy version; never trusted more. */
    country: z.string().trim().max(40).optional(),
  })
  .strict();

const marketingEmailSchema = z.object({
  granted: z.boolean(),
  country: z.string().trim().max(40).optional(),
});

const organizerConsentSchema = z.object({
  purpose: z.enum(ORGANIZER_PURPOSES),
  granted: z.boolean(),
  country: z.string().trim().max(40).optional(),
});

const orgIdParam = new ZodValidationPipe(z.string().trim().min(1).max(64));

/**
 * Following organizers: the customer's own follows and what they hear from each.
 *
 * Every route is the signed-in person's own data. There is no route here that takes a user id.
 */
@ApiTags('me')
@ApiBearerAuth()
@Controller('me/following')
export class MeFollowingController {
  constructor(private readonly follows: OrganizerFollowService) {}

  @Get()
  @ApiOperation({ summary: 'Organizers I follow, newest first.' })
  list(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(listSchema)) q: z.infer<typeof listSchema>,
  ) {
    return this.follows.list(user, q.page, q.pageSize);
  }

  @Get(':organizationId')
  @ApiOperation({ summary: 'Whether I follow this organizer.' })
  status(@CurrentUser() user: RequestUser, @Param('organizationId', orgIdParam) id: string) {
    return this.follows.status(user, id);
  }

  @Put(':organizationId')
  @ApiOperation({ summary: 'Follow an organizer. Idempotent. Grants no marketing consent.' })
  follow(
    @CurrentUser() user: RequestUser,
    @Param('organizationId', orgIdParam) id: string,
    @Body(new ZodValidationPipe(followSchema)) body: z.infer<typeof followSchema>,
  ) {
    return this.follows.follow(user, id, body.source);
  }

  @Delete(':organizationId')
  @ApiOperation({ summary: 'Stop following. Idempotent. Withdraws email from this organizer.' })
  unfollow(
    @CurrentUser() user: RequestUser,
    @Param('organizationId', orgIdParam) id: string,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.follows.unfollow(user, id, {
      source: 'withdrawn-on-unfollow',
      ipAddress: ip,
      userAgent,
      actorUserId: user.id,
    });
  }

  @Get(':organizationId/preferences')
  @ApiOperation({ summary: 'What I hear from one organizer I follow.' })
  preferences(@CurrentUser() user: RequestUser, @Param('organizationId', orgIdParam) id: string) {
    return this.follows.preferences(user, id);
  }

  @Put(':organizationId/preferences')
  @ApiOperation({ summary: 'Change what I hear from one organizer I follow.' })
  setPreferences(
    @CurrentUser() user: RequestUser,
    @Param('organizationId', orgIdParam) id: string,
    @Body(new ZodValidationPipe(preferencesSchema)) body: z.infer<typeof preferencesSchema>,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    const { country, ...input } = body;
    return this.follows.setPreferences(user, id, input, {
      source: 'following-preferences',
      ipAddress: ip,
      userAgent,
      actorUserId: user.id,
      country: policyJurisdictionFor(country),
    });
  }
}

/**
 * Communication consent with a scope: platform marketing email, and email from each
 * organizer. The person's own decisions and their full history.
 */
@ApiTags('me')
@ApiBearerAuth()
@Controller('me/communication-consent')
export class MeCommunicationConsentController {
  constructor(
    private readonly consent: CommunicationConsentService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'My marketing email consent, per organizer consent, and history.' })
  async get(@CurrentUser() user: RequestUser) {
    const subject = { userId: user.id, email: user.email };
    const [marketingEmail, rows, follows, history] = await Promise.all([
      this.consent.platformMarketingEmail(subject),
      this.consent.scopedRows(subject),
      this.prisma.organizerFollow.findMany({
        where: { userId: user.id },
        select: { organizationId: true },
      }),
      this.consent.history(subject),
    ]);
    const orgIds = [
      ...new Set([
        ...follows.map((f) => f.organizationId),
        ...rows.map((r) => r.organizationId).filter((id): id is string => !!id),
      ]),
    ];
    const orgs = orgIds.length
      ? await this.prisma.organization.findMany({
          where: { id: { in: orgIds } },
          select: { id: true, name: true },
        })
      : [];
    const followed = new Set(follows.map((f) => f.organizationId));
    const organizers = await Promise.all(
      orgs.map(async (org) => {
        const state = await this.consent.organizerState(subject, org.id);
        return {
          organizationId: org.id,
          name: org.name,
          following: followed.has(org.id),
          purposes: Object.fromEntries(
            ORGANIZER_PURPOSES.map((p) => [
              p,
              { granted: state[p].granted, decidedAt: state[p].decidedAt },
            ]),
          ),
        };
      }),
    );
    organizers.sort((a, b) => a.name.localeCompare(b.name));
    const names = new Map(orgs.map((o) => [o.id, o.name]));
    return {
      marketingEmail: { granted: marketingEmail.granted, decidedAt: marketingEmail.decidedAt },
      organizers,
      history: history.map((h) => ({
        purpose: h.purpose,
        organizationId: h.organizationId,
        organizationName: h.organizationId ? (names.get(h.organizationId) ?? null) : null,
        channel: h.channel,
        granted: h.granted,
        source: h.source,
        createdAt: h.createdAt,
      })),
    };
  }

  @Put('marketing-email')
  @ApiOperation({ summary: 'Allow or stop marketing email from ETicketsGo.' })
  async setMarketingEmail(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(marketingEmailSchema)) body: z.infer<typeof marketingEmailSchema>,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    await this.consent.record(
      { userId: user.id, email: user.email },
      { purpose: ConsentPurpose.MARKETING_EMAIL, organizationId: null, granted: body.granted },
      {
        source: body.granted
          ? 'account-settings:marketing-email'
          : 'withdrawn-by-user:marketing-email',
        ipAddress: ip,
        userAgent,
        actorUserId: user.id,
        country: policyJurisdictionFor(body.country),
      },
    );
    return this.get(user);
  }

  @Put('organizers/:organizationId')
  @ApiOperation({ summary: 'Allow or stop one kind of email from one organizer.' })
  async setOrganizer(
    @CurrentUser() user: RequestUser,
    @Param('organizationId', orgIdParam) organizationId: string,
    @Body(new ZodValidationPipe(organizerConsentSchema))
    body: z.infer<typeof organizerConsentSchema>,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    const exists = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    });
    if (!exists) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Organizer not found.', HttpStatus.NOT_FOUND);
    }
    await this.consent.record(
      { userId: user.id, email: user.email },
      { purpose: body.purpose, organizationId, granted: body.granted },
      {
        source: body.granted
          ? `account-settings:${body.purpose}`
          : `withdrawn-by-user:${body.purpose}`,
        ipAddress: ip,
        userAgent,
        actorUserId: user.id,
        country: policyJurisdictionFor(body.country),
      },
    );
    // Keep the follower's topic mirror in step. The consent row stays the evidence.
    const mirror =
      body.purpose === ConsentPurpose.EARLY_ACCESS
        ? { earlyAccess: body.granted }
        : body.purpose === ConsentPurpose.OFFERS
          ? { offers: body.granted }
          : null;
    if (mirror) {
      await this.prisma.organizerNotificationPreference.updateMany({
        where: { userId: user.id, organizationId },
        data: mirror,
      });
    }
    return this.get(user);
  }
}

/**
 * The signed unsubscribe link. No sign-in: the HMAC signature is the authority.
 *
 * GET shows what will stop and changes nothing (mail scanners open every link). POST does
 * it, and is also the RFC 8058 one-click target: a mail provider POSTs
 * `List-Unsubscribe=One-Click` to the URL in the `List-Unsubscribe` header.
 */
@ApiTags('public')
@Controller('public/unsubscribe')
export class PublicUnsubscribeController {
  constructor(private readonly unsubscribe: UnsubscribeService) {}

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get(':token')
  @ApiOperation({ summary: 'What this unsubscribe link would stop. Changes nothing.' })
  preview(@Param('token') token: string) {
    return this.unsubscribe.preview(token);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post(':token')
  @HttpCode(200)
  @ApiOperation({ summary: 'Unsubscribe. Also the RFC 8058 one-click endpoint.' })
  confirm(
    @Param('token') token: string,
    @Body() body: Record<string, unknown> | undefined,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    const oneClick = body?.['List-Unsubscribe'] === 'One-Click';
    return this.unsubscribe.unsubscribe(token, { ipAddress: ip, userAgent, oneClick });
  }
}

/** The organizer's audience, as aggregates only. Owners and managers of this organization. */
@ApiTags('organizations')
@ApiBearerAuth()
@Controller('organizations/:id/audience')
export class OrganizerAudienceController {
  constructor(private readonly audience: AudienceSummaryService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Follower and audience counts. No personal data.' })
  summary(@CurrentUser() user: RequestUser, @Param('id', orgIdParam) id: string) {
    return this.audience.summary(user, id);
  }
}
