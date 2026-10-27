import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type Campaign } from '@prisma/client';
import { EntitlementKey, Role } from '@eticketsgo/shared-types';
import { isLocale } from '@eticketsgo/i18n';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { EntitlementService } from '../billing/entitlements/entitlement.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';
import { isOrganizerPurpose } from '../engagement/consent-purpose';
import { buildUnsubscribeLinks, ALL_ORGANIZER_PURPOSES } from '../engagement/unsubscribe-token';
import {
  CAMPAIGN_TEMPLATES,
  buttonUrlsIn,
  contentSchema,
  eventIdsIn,
  templateStart,
  type CampaignContent,
  type CampaignTemplateKey,
} from './campaign-content';
import {
  audienceSchema,
  usesAdvancedAudience,
  type AudienceDefinition,
  type SegmentDefinition,
} from './campaign-audience';
import { CampaignAudienceService } from './campaign-audience.service';
import { CampaignRenderService } from './campaign-render.service';
import { allowedCampaignTarget } from './campaign-links';
import {
  CampaignAction,
  CampaignStatus,
  transition,
  type CampaignStatus as Status,
} from './campaign-state';
import {
  DEFAULT_QUIET_HOURS,
  isQuietTime,
  isValidTimeZone,
  nextSendableTime,
  quietHoursProblem,
  type QuietHours,
} from './quiet-hours';
import {
  campaignFromHeader,
  campaignSendingConfig,
  isSimulatorAddress,
} from './campaign-sending-config';
import { CAMPAIGN_TRANSPORT, type CampaignTransport } from './campaign-transport';
import { signConfirmation, verifyConfirmation } from './campaign-guard';

const MANAGERS = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER];
const QUOTA_KEY = EntitlementKey.CAMPAIGNS_MONTHLY_EMAIL_QUOTA;
/** The furthest ahead a campaign can be scheduled. */
const MAX_SCHEDULE_AHEAD_MS = 180 * 24 * 3600_000;
/** The soonest: a little time to pause it if somebody notices a typo. */
const MIN_SCHEDULE_AHEAD_MS = 5 * 60_000;
export const TEST_SENDS_PER_CAMPAIGN_PER_HOUR = 10;
export const TEST_SENDS_PER_ORG_PER_HOUR = 30;
export const TEST_RECIPIENTS_MAX = 5;

/** What an organizer sends to create or edit a draft. Validated by the controller's zod schema. */
export interface CampaignDraftInput {
  name?: string;
  subject?: string;
  previewText?: string | null;
  senderName?: string;
  replyTo?: string | null;
  purpose?: string;
  templateKey?: CampaignTemplateKey;
  content?: unknown;
  eventId?: string | null;
  audience?: unknown;
  timezone?: string;
  quietHours?: QuietHours | null;
  locale?: string;
}

/** The campaign as the console sees it. No recipient, no address, ever. */
export function campaignView(c: Campaign) {
  return {
    id: c.id,
    organizationId: c.organizationId,
    name: c.name,
    subject: c.subject,
    previewText: c.previewText,
    senderName: c.senderName,
    replyTo: c.replyTo,
    purpose: c.purpose,
    templateKey: c.templateKey,
    content: c.content,
    eventId: c.eventId,
    audience: c.audience,
    status: c.status,
    scheduledAt: c.scheduledAt?.toISOString() ?? null,
    timezone: c.timezone,
    quietHours: c.quietHours,
    locale: c.locale,
    version: c.version,
    counters: c.counters,
    pausedReason: c.pausedReason,
    failureReason: c.failureReason,
    confirmedAt: c.confirmedAt?.toISOString() ?? null,
    queuedAt: c.queuedAt?.toISOString() ?? null,
    startedAt: c.startedAt?.toISOString() ?? null,
    completedAt: c.completedAt?.toISOString() ?? null,
    cancelledAt: c.cancelledAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

function bad(message: string, details?: Record<string, unknown>): never {
  throw new AppException(ErrorCodes.VALIDATION_FAILED, message, HttpStatus.BAD_REQUEST, details);
}

/**
 * Organizer campaigns: drafts, the review step, scheduling, sending and the controls a person
 * has once it is going.
 *
 * ── WHO ────────────────────────────────────────────────────────────────────────────
 * Owners and managers of the organization (`assertMember`), with the plan entitlement for
 * the action, in a deployment with CAMPAIGNS_ENABLED. Checked here, not only in the route
 * guard, so a call from anywhere else is held to the same rule.
 *
 * ── WHAT IS NEVER RETURNED ─────────────────────────────────────────────────────────
 * A recipient. The organizer sees counts and statuses. The addresses live in
 * CampaignRecipient for as long as a send needs them, and no route reads them out.
 */
@Injectable()
export class CampaignsService {
  private readonly logger = new Logger('Campaigns');

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly access: OrgAccessService,
    private readonly entitlements: EntitlementService,
    private readonly audience: CampaignAudienceService,
    private readonly renderer: CampaignRenderService,
    @Inject(CAMPAIGN_TRANSPORT) private readonly transport: CampaignTransport,
  ) {}

  // ── Access ──────────────────────────────────────────────────────────────────────

  private enabled(): boolean {
    return String(this.config.get<string>('CAMPAIGNS_ENABLED') ?? 'false') === 'true';
  }

  private assertEnabled(): void {
    if (!this.enabled()) {
      throw new AppException(
        ErrorCodes.CAMPAIGNS_NOT_ENABLED,
        'Email campaigns are not switched on yet.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  /** Member first (so a stranger learns nothing), then the switch, then the plan. */
  async authorize(user: RequestUser, organizationId: string, key?: EntitlementKey): Promise<void> {
    await this.access.assertMember(user, organizationId, MANAGERS);
    this.assertEnabled();
    await this.entitlements.assert(organizationId, key ?? EntitlementKey.CAMPAIGNS_CREATE);
  }

  private async load(organizationId: string, campaignId: string): Promise<Campaign> {
    const c = await this.prisma.campaign.findFirst({ where: { id: campaignId, organizationId } });
    if (!c) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Campaign not found.', HttpStatus.NOT_FOUND);
    }
    return c;
  }

  // ── Status: what the console needs to decide what to show ───────────────────────

  async status(user: RequestUser, organizationId: string) {
    await this.access.assertMember(user, organizationId, MANAGERS);
    const enabled = this.enabled();
    const sending = campaignSendingConfig(this.config);
    const resolved = await this.entitlements.resolve(organizationId);
    const has = (k: EntitlementKey) =>
      resolved.entitlements.find((e) => e.key === k)?.enabled ?? false;
    const quota =
      enabled && has(EntitlementKey.CAMPAIGNS_CREATE)
        ? await this.entitlements.remaining(organizationId, QUOTA_KEY)
        : null;
    return {
      enabled,
      planCode: resolved.planCode,
      sending: { allowed: !sending.refusal, mode: sending.mode, refusal: sending.refusal },
      entitlements: {
        create: has(EntitlementKey.CAMPAIGNS_CREATE),
        schedule: has(EntitlementKey.CAMPAIGNS_SCHEDULE),
        analyticsBasic: has(EntitlementKey.CAMPAIGNS_ANALYTICS_BASIC),
        analyticsAdvanced: has(EntitlementKey.CAMPAIGNS_ANALYTICS_ADVANCED),
        audienceAdvanced: has(EntitlementKey.AUDIENCE_ADVANCED),
      },
      quota: quota
        ? {
            periodKey: quota.periodKey,
            quota: quota.quota,
            used: quota.used,
            credits: quota.credits,
            remaining: quota.remaining,
          }
        : null,
      defaults: { quietHours: DEFAULT_QUIET_HOURS },
      templates: Object.values(CAMPAIGN_TEMPLATES).map((t) => ({
        key: t.key,
        label: t.label,
        description: t.description,
        purpose: t.purpose,
        needsEvent: t.needsEvent,
      })),
    };
  }

  // ── Drafts ──────────────────────────────────────────────────────────────────────

  async list(
    user: RequestUser,
    organizationId: string,
    q: { status?: Status; page: number; pageSize: number },
  ) {
    await this.authorize(user, organizationId);
    const where: Prisma.CampaignWhereInput = {
      organizationId,
      ...(q.status ? { status: q.status } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.campaign.count({ where }),
      this.prisma.campaign.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    return { total, page: q.page, pageSize: q.pageSize, items: rows.map(campaignView) };
  }

  async get(user: RequestUser, organizationId: string, campaignId: string) {
    await this.authorize(user, organizationId);
    return campaignView(await this.load(organizationId, campaignId));
  }

  /** Content, audience and settings checks shared by create and edit. */
  private async validateDraft(
    organizationId: string,
    draft: {
      content: unknown;
      audience: unknown;
      eventId: string | null;
      purpose: string;
      replyTo: string | null;
      timezone: string;
      quietHours: QuietHours | null;
      locale: string;
    },
  ): Promise<{ content: CampaignContent; audience: AudienceDefinition }> {
    const content = contentSchema.safeParse(draft.content);
    if (!content.success) {
      bad('The email content is not valid.', { issues: content.error.issues.slice(0, 5) });
    }
    const audience = audienceSchema.safeParse(draft.audience);
    if (!audience.success) {
      bad(audience.error.issues[0]?.message ?? 'The audience is not valid.', {
        issues: audience.error.issues.slice(0, 5),
      });
    }
    if (!isOrganizerPurpose(draft.purpose)) bad('Choose what kind of email this is.');
    if (!isValidTimeZone(draft.timezone)) bad('Choose a valid time zone.');
    const qh = quietHoursProblem(draft.quietHours);
    if (qh) bad(qh);
    if (!isLocale(draft.locale)) bad('Choose a supported language.');
    if (draft.replyTo && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(draft.replyTo)) {
      bad('The reply-to address is not a valid email address.');
    }
    for (const url of buttonUrlsIn(content.data)) {
      if (!allowedCampaignTarget(this.config, url)) {
        bad('A button links to a website we cannot link to. Link to your ETicketsGo pages only.', {
          url,
        });
      }
    }
    const ids = [
      ...new Set([...eventIdsIn(content.data), ...(draft.eventId ? [draft.eventId] : [])]),
    ];
    if (ids.length) {
      const own = await this.prisma.event.count({ where: { id: { in: ids }, organizationId } });
      if (own !== ids.length) bad('One of the events is not one of yours.');
    }
    return { content: content.data, audience: audience.data };
  }

  async create(user: RequestUser, organizationId: string, input: CampaignDraftInput) {
    await this.authorize(user, organizationId);
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true },
    });
    const templateKey: CampaignTemplateKey = input.templateKey ?? 'EVENT_ANNOUNCEMENT';
    const event = input.eventId
      ? await this.prisma.event.findFirst({
          where: { id: input.eventId, organizationId },
          select: { id: true, title: true },
        })
      : null;
    if (input.eventId && !event) bad('That event is not one of yours.');
    const start = templateStart(templateKey, { event, organizer: org?.name ?? 'us' });
    const draft = {
      content: input.content ?? start.content,
      audience: input.audience ?? { sources: ['FOLLOWERS'] },
      eventId: event?.id ?? null,
      purpose: input.purpose ?? start.purpose,
      replyTo: input.replyTo ?? null,
      timezone: input.timezone ?? 'UTC',
      quietHours: input.quietHours === undefined ? DEFAULT_QUIET_HOURS : input.quietHours,
      locale: input.locale ?? 'en',
    };
    const { content, audience } = await this.validateDraft(organizationId, draft);
    await this.assertAudienceAllowed(organizationId, audience);
    const row = await this.prisma.campaign.create({
      data: {
        organizationId,
        name:
          input.name ??
          `${CAMPAIGN_TEMPLATES[templateKey].label}${event ? `: ${event.title}` : ''}`.slice(
            0,
            120,
          ),
        subject: input.subject ?? start.subject,
        previewText: input.previewText === undefined ? start.previewText : input.previewText,
        senderName: input.senderName ?? org?.name ?? 'Organizer',
        replyTo: draft.replyTo,
        purpose: draft.purpose,
        templateKey,
        content: content as unknown as Prisma.InputJsonValue,
        eventId: draft.eventId,
        audience: audience as unknown as Prisma.InputJsonValue,
        timezone: draft.timezone,
        quietHours: draft.quietHours
          ? (draft.quietHours as unknown as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        locale: draft.locale,
        createdByUserId: user.id,
      },
    });
    await this.history(row.id, 'STATUS_CHANGED', user.id, { to: 'DRAFT', action: 'CREATE' });
    await this.audit.record({
      actorUserId: user.id,
      organizationId,
      action: 'CAMPAIGN_CREATED',
      entityType: 'Campaign',
      entityId: row.id,
      metadata: { templateKey, purpose: row.purpose },
    });
    return campaignView(row);
  }

  async update(
    user: RequestUser,
    organizationId: string,
    campaignId: string,
    input: CampaignDraftInput & { version: number },
  ) {
    await this.authorize(user, organizationId);
    const current = await this.load(organizationId, campaignId);
    this.assertMove(current.status as Status, CampaignAction.EDIT);
    const merged = {
      content: input.content ?? current.content,
      audience: input.audience ?? current.audience,
      eventId: input.eventId === undefined ? current.eventId : input.eventId,
      purpose: input.purpose ?? current.purpose,
      replyTo: input.replyTo === undefined ? current.replyTo : input.replyTo,
      timezone: input.timezone ?? current.timezone,
      quietHours:
        input.quietHours === undefined
          ? (current.quietHours as QuietHours | null)
          : input.quietHours,
      locale: input.locale ?? current.locale,
    };
    const { content, audience } = await this.validateDraft(organizationId, merged);
    await this.assertAudienceAllowed(organizationId, audience);
    const res = await this.prisma.campaign.updateMany({
      where: { id: campaignId, organizationId, version: input.version, status: 'DRAFT' },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        ...(input.previewText !== undefined ? { previewText: input.previewText } : {}),
        ...(input.senderName !== undefined ? { senderName: input.senderName } : {}),
        ...(input.templateKey !== undefined ? { templateKey: input.templateKey } : {}),
        replyTo: merged.replyTo,
        purpose: merged.purpose,
        content: content as unknown as Prisma.InputJsonValue,
        eventId: merged.eventId,
        audience: audience as unknown as Prisma.InputJsonValue,
        timezone: merged.timezone,
        quietHours: merged.quietHours
          ? (merged.quietHours as unknown as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        locale: merged.locale,
        updatedByUserId: user.id,
        version: { increment: 1 },
      },
    });
    if (res.count !== 1) this.stale();
    return campaignView(await this.load(organizationId, campaignId));
  }

  async duplicate(user: RequestUser, organizationId: string, campaignId: string) {
    await this.authorize(user, organizationId);
    const c = await this.load(organizationId, campaignId);
    const row = await this.prisma.campaign.create({
      data: {
        organizationId,
        name: `${c.name} (copy)`.slice(0, 120),
        subject: c.subject,
        previewText: c.previewText,
        senderName: c.senderName,
        replyTo: c.replyTo,
        purpose: c.purpose,
        templateKey: c.templateKey,
        content: c.content as Prisma.InputJsonValue,
        eventId: c.eventId,
        audience: c.audience as Prisma.InputJsonValue,
        timezone: c.timezone,
        quietHours: c.quietHours ? (c.quietHours as Prisma.InputJsonValue) : Prisma.JsonNull,
        locale: c.locale,
        createdByUserId: user.id,
      },
    });
    await this.history(row.id, 'STATUS_CHANGED', user.id, {
      to: 'DRAFT',
      action: 'DUPLICATE',
      from: c.id,
    });
    return campaignView(row);
  }

  // ── Audience ────────────────────────────────────────────────────────────────────

  private async assertAudienceAllowed(organizationId: string, def: AudienceDefinition) {
    if (usesAdvancedAudience(def)) {
      await this.entitlements.assert(organizationId, EntitlementKey.AUDIENCE_ADVANCED);
    }
  }

  /** Counts only, plus what sending would cost against the plan. */
  async previewAudience(
    user: RequestUser,
    organizationId: string,
    input: { audience?: unknown; purpose: string },
  ) {
    await this.authorize(user, organizationId);
    const parsed = audienceSchema.safeParse(input.audience);
    if (!parsed.success) bad(parsed.error.issues[0]?.message ?? 'The audience is not valid.');
    if (!isOrganizerPurpose(input.purpose)) bad('Choose what kind of email this is.');
    await this.assertAudienceAllowed(organizationId, parsed.data);
    const def = await this.audience.resolve(organizationId, parsed.data);
    return this.countsWithQuota(organizationId, input.purpose, def);
  }

  async campaignAudience(user: RequestUser, organizationId: string, campaignId: string) {
    await this.authorize(user, organizationId);
    const c = await this.load(organizationId, campaignId);
    const def = await this.audience.resolve(organizationId, audienceSchema.parse(c.audience));
    return this.countsWithQuota(organizationId, c.purpose, def);
  }

  private async countsWithQuota(organizationId: string, purpose: string, def: SegmentDefinition) {
    const [counts, quota] = await Promise.all([
      this.audience.counts(organizationId, purpose, def),
      this.entitlements.remaining(organizationId, QUOTA_KEY),
    ]);
    return {
      ...counts,
      /** One email credit per eligible person. Skipped people cost nothing. */
      estimatedCredits: counts.eligible,
      quotaRemaining: quota.remaining,
      enoughQuota: quota.remaining >= counts.eligible,
    };
  }

  // ── Preview and test send ───────────────────────────────────────────────────────

  async preview(user: RequestUser, organizationId: string, campaignId: string) {
    await this.authorize(user, organizationId);
    const c = await this.load(organizationId, campaignId);
    const ctx = await this.renderer.context(c);
    // Links point straight at their targets: a preview is never tracked. The iframe that
    // shows it is sandboxed, so nothing in it can run or navigate the console.
    const rendered = this.renderer.render(c, ctx, {
      link: (target) => target,
      unsubscribeUrl: this.previewUnsubscribeUrl(),
    });
    return {
      subject: c.subject,
      previewText: c.previewText,
      html: rendered.html,
      text: rendered.text,
    };
  }

  private previewUnsubscribeUrl(): string {
    const origin = this.config.get<string>('CUSTOMER_WEB_URL')?.trim().replace(/\/+$/, '');
    return `${origin || 'http://localhost:3000'}/unsubscribe/preview`;
  }

  /**
   * Who a test may go to: the caller's own address, or another member's, VERIFIED in both
   * cases; and outside STAGING/PRODUCTION the SES mailbox simulator. Never an audience member:
   * there is no way to name one, because the organizer never learns an address.
   */
  private async allowedTestRecipients(
    user: RequestUser,
    organizationId: string,
    requested: string[],
  ): Promise<string[]> {
    const sending = campaignSendingConfig(this.config);
    const wanted = [...new Set(requested.map((e) => e.trim().toLowerCase()))].filter(Boolean);
    if (wanted.length === 0) bad('Add at least one address.');
    if (wanted.length > TEST_RECIPIENTS_MAX)
      bad(`Send a test to at most ${TEST_RECIPIENTS_MAX} addresses.`);
    const members = await this.prisma.organizationMember.findMany({
      where: { organizationId, status: 'ACTIVE' },
      select: { user: { select: { email: true, emailVerifiedAt: true } } },
    });
    const self = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { email: true, emailVerifiedAt: true },
    });
    const verified = new Set(
      [...members.map((m) => m.user), ...(self ? [self] : [])]
        .filter((u) => !!u.emailVerifiedAt)
        .map((u) => u.email.trim().toLowerCase()),
    );
    for (const email of wanted) {
      if (verified.has(email)) continue;
      if (sending.simulatorAllowed && isSimulatorAddress(email)) continue;
      bad(
        'A test can go only to your own verified email address or to a team member with a verified address.',
        { email },
      );
    }
    return wanted;
  }

  async testSend(
    user: RequestUser,
    organizationId: string,
    campaignId: string,
    input: { to: string[] },
  ) {
    await this.authorize(user, organizationId);
    const sending = campaignSendingConfig(this.config);
    if (sending.refusal) bad(sending.refusal);
    const c = await this.load(organizationId, campaignId);
    const to = await this.allowedTestRecipients(user, organizationId, input.to);
    const hourAgo = new Date(Date.now() - 3600_000);
    const [forCampaign, forOrg] = await Promise.all([
      this.prisma.campaignEvent.count({
        where: { campaignId, type: 'TEST_SENT', occurredAt: { gte: hourAgo } },
      }),
      this.prisma.campaignEvent.count({
        where: {
          type: 'TEST_SENT',
          occurredAt: { gte: hourAgo },
          campaignId: {
            in: (
              await this.prisma.campaign.findMany({
                where: { organizationId },
                select: { id: true },
              })
            ).map((x) => x.id),
          },
        },
      }),
    ]);
    if (
      forCampaign + to.length > TEST_SENDS_PER_CAMPAIGN_PER_HOUR ||
      forOrg + to.length > TEST_SENDS_PER_ORG_PER_HOUR
    ) {
      throw new AppException(
        ErrorCodes.RATE_LIMITED,
        'You have sent a lot of tests in the last hour. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const ctx = await this.renderer.context(c);
    const results: { email: string; accepted: boolean }[] = [];
    for (const email of to) {
      const links = buildUnsubscribeLinks(this.config, {
        userId: null,
        email,
        scope: 'organizer',
        organizationId,
        purpose: ALL_ORGANIZER_PURPOSES,
      });
      const rendered = this.renderer.render(c, ctx, {
        link: (target) => target,
        unsubscribeUrl: links.pageUrl,
        isTest: true,
      });
      try {
        await this.transport.send({
          to: email,
          from: campaignFromHeader(c.senderName, sending.fromAddress!),
          replyTo: c.replyTo,
          subject: `[Test] ${c.subject}`,
          html: rendered.html,
          text: rendered.text,
          configurationSet: sending.configurationSet,
          listUnsubscribe: links.headers,
        });
        results.push({ email, accepted: true });
      } catch (err) {
        this.logger.warn(`test send refused: ${(err as Error)?.name ?? 'Error'}`);
        results.push({ email, accepted: false });
      }
      await this.history(campaignId, 'TEST_SENT', user.id, {
        accepted: results[results.length - 1].accepted,
        simulator: isSimulatorAddress(email),
      });
    }
    await this.audit.record({
      actorUserId: user.id,
      organizationId,
      action: 'CAMPAIGN_TEST_SENT',
      entityType: 'Campaign',
      entityId: campaignId,
      metadata: { recipients: to.length, accepted: results.filter((r) => r.accepted).length },
    });
    return { sent: results.filter((r) => r.accepted).length, results };
  }

  // ── Review, schedule, send ──────────────────────────────────────────────────────

  /**
   * The last check before sending. Returns every problem at once (so the page can list them)
   * and, when there are none, the confirmation token "send" and "schedule" require.
   */
  async review(user: RequestUser, organizationId: string, campaignId: string) {
    await this.authorize(user, organizationId);
    const c = await this.load(organizationId, campaignId);
    const problems: string[] = [];
    const sending = campaignSendingConfig(this.config);
    if (sending.refusal) problems.push(sending.refusal);
    let counts: Awaited<ReturnType<CampaignsService['countsWithQuota']>> | null = null;
    try {
      const def = await this.audience.resolve(organizationId, audienceSchema.parse(c.audience));
      counts = await this.countsWithQuota(organizationId, c.purpose, def);
      if (counts.eligible === 0) {
        problems.push('Nobody in this audience has agreed to get this kind of email from you yet.');
      } else if (!counts.enoughQuota) {
        problems.push(
          `This campaign needs ${counts.estimatedCredits} emails and your plan has ${counts.quotaRemaining} left this month.`,
        );
      }
    } catch (err) {
      problems.push((err as Error).message || 'The audience could not be checked.');
    }
    try {
      buildUnsubscribeLinks(this.config, {
        userId: null,
        email: 'check@example.com',
        scope: 'organizer',
        organizationId,
        purpose: ALL_ORGANIZER_PURPOSES,
      });
    } catch {
      problems.push('The unsubscribe link cannot be built in this environment.');
    }
    const now = new Date();
    const quiet = c.quietHours as QuietHours | null;
    const quietNow = isQuietTime(now, c.timezone, quiet);
    return {
      campaign: campaignView(c),
      audience: counts,
      sendingMode: sending.mode,
      quietHoursNow: quietNow,
      nextSendableAt: nextSendableTime(now, c.timezone, quiet).toISOString(),
      canSchedule: await this.entitlements.has(organizationId, EntitlementKey.CAMPAIGNS_SCHEDULE),
      problems,
      confirmationToken: problems.length ? null : signConfirmation(this.config, c.id, c.version),
    };
  }

  private assertConfirmed(c: Campaign, token: string | undefined) {
    if (!verifyConfirmation(this.config, c.id, c.version, token)) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'Review the campaign again before you send it. Something changed, or the review is more than 15 minutes old.',
        HttpStatus.CONFLICT,
        { reason: 'CONFIRMATION_REQUIRED' },
      );
    }
  }

  /** The checks review makes, repeated at the moment of commitment: nothing may drift in between. */
  private async assertSendable(c: Campaign) {
    if (c.pausedReason === 'ADMIN') {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'ETicketsGo paused this campaign. Contact support before you send it.',
        HttpStatus.FORBIDDEN,
      );
    }
    const sending = campaignSendingConfig(this.config);
    if (sending.refusal) bad(sending.refusal);
    const def = await this.audience.resolve(c.organizationId, audienceSchema.parse(c.audience));
    const counts = await this.countsWithQuota(c.organizationId, c.purpose, def);
    if (counts.eligible === 0) bad('Nobody in this audience can get this email.');
    if (!counts.enoughQuota) {
      throw new AppException(
        ErrorCodes.QUOTA_EXCEEDED,
        `This campaign needs ${counts.estimatedCredits} emails and your plan has ${counts.quotaRemaining} left this month.`,
        HttpStatus.CONFLICT,
        { needed: counts.estimatedCredits, remaining: counts.quotaRemaining },
      );
    }
  }

  private validScheduleTime(c: Campaign, at: Date, now = new Date()) {
    if (Number.isNaN(at.getTime())) bad('Choose a date and time.');
    if (at.getTime() < now.getTime() + MIN_SCHEDULE_AHEAD_MS) {
      bad('Choose a time at least 5 minutes from now.');
    }
    if (at.getTime() > now.getTime() + MAX_SCHEDULE_AHEAD_MS) {
      bad('Choose a time within the next 6 months.');
    }
    const quiet = c.quietHours as QuietHours | null;
    if (isQuietTime(at, c.timezone, quiet)) {
      bad(
        `That time is inside your quiet hours (${quiet!.start} to ${quiet!.end}, ${c.timezone}). The next time you can send is ${nextSendableTime(at, c.timezone, quiet).toISOString()}.`,
        { nextSendableAt: nextSendableTime(at, c.timezone, quiet).toISOString() },
      );
    }
  }

  async schedule(
    user: RequestUser,
    organizationId: string,
    campaignId: string,
    input: { scheduledAt: string; version: number; confirmationToken?: string },
  ) {
    await this.authorize(user, organizationId, EntitlementKey.CAMPAIGNS_SCHEDULE);
    await this.entitlements.assert(organizationId, EntitlementKey.CAMPAIGNS_CREATE);
    const c = await this.load(organizationId, campaignId);
    this.assertMove(c.status as Status, CampaignAction.SCHEDULE);
    this.assertVersion(c, input.version);
    this.assertConfirmed(c, input.confirmationToken);
    const at = new Date(input.scheduledAt);
    this.validScheduleTime(c, at);
    await this.assertSendable(c);
    return this.move(
      user,
      c,
      CampaignAction.SCHEDULE,
      {
        scheduledAt: at,
        confirmedAt: new Date(),
        confirmedByUserId: user.id,
      },
      'CAMPAIGN_SCHEDULED',
      { scheduledAt: at.toISOString() },
    );
  }

  async reschedule(
    user: RequestUser,
    organizationId: string,
    campaignId: string,
    input: { scheduledAt: string; version: number },
  ) {
    await this.authorize(user, organizationId, EntitlementKey.CAMPAIGNS_SCHEDULE);
    const c = await this.load(organizationId, campaignId);
    this.assertMove(c.status as Status, CampaignAction.RESCHEDULE);
    this.assertVersion(c, input.version);
    const at = new Date(input.scheduledAt);
    this.validScheduleTime(c, at);
    return this.move(
      user,
      c,
      CampaignAction.RESCHEDULE,
      { scheduledAt: at },
      'CAMPAIGN_RESCHEDULED',
      {
        scheduledAt: at.toISOString(),
      },
    );
  }

  async unschedule(user: RequestUser, organizationId: string, campaignId: string, version: number) {
    await this.authorize(user, organizationId);
    const c = await this.load(organizationId, campaignId);
    this.assertVersion(c, version);
    return this.move(
      user,
      c,
      CampaignAction.UNSCHEDULE,
      { scheduledAt: null, confirmedAt: null },
      'CAMPAIGN_UNSCHEDULED',
    );
  }

  async sendNow(
    user: RequestUser,
    organizationId: string,
    campaignId: string,
    input: { version: number; confirmationToken?: string },
  ) {
    await this.authorize(user, organizationId);
    const c = await this.load(organizationId, campaignId);
    this.assertMove(c.status as Status, CampaignAction.SEND_NOW);
    this.assertVersion(c, input.version);
    this.assertConfirmed(c, input.confirmationToken);
    const now = new Date();
    const quiet = c.quietHours as QuietHours | null;
    if (isQuietTime(now, c.timezone, quiet)) {
      bad(
        `It is quiet hours where your audience is (${quiet!.start} to ${quiet!.end}, ${c.timezone}). Schedule it for ${nextSendableTime(now, c.timezone, quiet).toISOString()} or later.`,
        { nextSendableAt: nextSendableTime(now, c.timezone, quiet).toISOString() },
      );
    }
    await this.assertSendable(c);
    return this.move(
      user,
      c,
      CampaignAction.SEND_NOW,
      {
        queuedAt: now,
        confirmedAt: now,
        confirmedByUserId: user.id,
      },
      'CAMPAIGN_SEND_CONFIRMED',
    );
  }

  async cancel(user: RequestUser, organizationId: string, campaignId: string, version: number) {
    await this.authorize(user, organizationId);
    const c = await this.load(organizationId, campaignId);
    this.assertVersion(c, version);
    const view = await this.move(
      user,
      c,
      CampaignAction.CANCEL,
      { cancelledAt: new Date() },
      'CAMPAIGN_CANCELLED',
    );
    // Nothing more will be sent, so the addresses kept for sending are no longer needed.
    await this.prisma.campaignRecipient.updateMany({
      where: { campaignId, status: { in: ['PENDING', 'QUEUED'] }, destination: { not: null } },
      data: { destination: null },
    });
    return view;
  }

  async pause(user: RequestUser, organizationId: string, campaignId: string, version: number) {
    await this.authorize(user, organizationId);
    const c = await this.load(organizationId, campaignId);
    this.assertVersion(c, version);
    return this.move(
      user,
      c,
      CampaignAction.PAUSE,
      { pausedReason: 'ORGANIZER' },
      'CAMPAIGN_PAUSED',
    );
  }

  async resume(user: RequestUser, organizationId: string, campaignId: string, version: number) {
    await this.authorize(user, organizationId);
    const c = await this.load(organizationId, campaignId);
    this.assertVersion(c, version);
    const quiet = c.quietHours as QuietHours | null;
    if (isQuietTime(new Date(), c.timezone, quiet)) {
      // Allowed: the worker holds the mail until quiet hours end. Said here so it is not a surprise.
      this.logger.log(`campaign ${c.id} resumed during quiet hours; sending waits`);
    }
    await this.assertSendable(c);
    return this.move(user, c, CampaignAction.RESUME, { pausedReason: null }, 'CAMPAIGN_RESUMED');
  }

  // ── History ─────────────────────────────────────────────────────────────────────

  async historyFor(
    user: RequestUser,
    organizationId: string,
    campaignId: string,
    q: { page: number; pageSize: number },
  ) {
    await this.authorize(user, organizationId);
    await this.load(organizationId, campaignId);
    // Campaign-level history only: status changes, tests, and failures by kind. Per-recipient
    // events are summarised in the stats, never listed - a list would be a list of people.
    const where = {
      campaignId,
      type: { in: ['STATUS_CHANGED', 'TEST_SENT', 'PAUSED_BY_SYSTEM', 'QUOTA_OVERRUN'] },
    };
    const [total, items] = await Promise.all([
      this.prisma.campaignEvent.count({ where }),
      this.prisma.campaignEvent.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: { id: true, type: true, actorUserId: true, detail: true, occurredAt: true },
      }),
    ]);
    return { total, page: q.page, pageSize: q.pageSize, items };
  }

  // ── Internals ───────────────────────────────────────────────────────────────────

  private assertMove(from: Status, action: CampaignAction) {
    const r = transition(from, action);
    if (!r.ok) {
      throw new AppException(
        ErrorCodes.CAMPAIGN_TRANSITION_INVALID,
        r.reason,
        HttpStatus.CONFLICT,
        {
          from,
          action,
        },
      );
    }
    return r.to;
  }

  private assertVersion(c: Campaign, version: number) {
    if (c.version !== version) this.stale();
  }

  private stale(): never {
    throw new AppException(
      ErrorCodes.CONFLICT,
      'Somebody else changed this campaign. Reload it and try again.',
      HttpStatus.CONFLICT,
      { reason: 'STALE_VERSION' },
    );
  }

  /** One guarded move: the status AND version must still be what we read. */
  private async move(
    user: RequestUser,
    c: Campaign,
    action: CampaignAction,
    data: Prisma.CampaignUpdateManyMutationInput,
    auditAction: string,
    metadata: Record<string, unknown> = {},
  ) {
    const to = this.assertMove(c.status as Status, action);
    const res = await this.prisma.campaign.updateMany({
      where: { id: c.id, organizationId: c.organizationId, status: c.status, version: c.version },
      data: { ...data, status: to, updatedByUserId: user.id, version: { increment: 1 } },
    });
    if (res.count !== 1) this.stale();
    await this.history(c.id, 'STATUS_CHANGED', user.id, {
      from: c.status,
      to,
      action,
      ...metadata,
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: c.organizationId,
      action: auditAction,
      entityType: 'Campaign',
      entityId: c.id,
      metadata: { from: c.status, to, ...metadata },
    });
    return campaignView(await this.load(c.organizationId, c.id));
  }

  private async history(
    campaignId: string,
    type: string,
    actorUserId: string | null,
    detail: Record<string, unknown>,
  ) {
    await this.prisma.campaignEvent.create({
      data: { campaignId, type, actorUserId, detail: detail as Prisma.InputJsonValue },
    });
  }

  /** Segments: same access, plus the advanced-audience entitlement. */
  async segments(user: RequestUser, organizationId: string) {
    await this.authorize(user, organizationId);
    return this.audience.listSegments(organizationId);
  }

  async createSegment(
    user: RequestUser,
    organizationId: string,
    input: { name: string; definition: SegmentDefinition },
  ) {
    await this.authorize(user, organizationId, EntitlementKey.AUDIENCE_ADVANCED);
    if (input.definition.eventIds?.length) {
      const own = await this.prisma.event.count({
        where: { id: { in: input.definition.eventIds }, organizationId },
      });
      if (own !== new Set(input.definition.eventIds).size)
        bad('One of the events is not one of yours.');
    }
    return this.audience.createSegment(organizationId, user.id, input.name, input.definition);
  }

  async deleteSegment(user: RequestUser, organizationId: string, segmentId: string) {
    await this.authorize(user, organizationId);
    return this.audience.deleteSegment(organizationId, segmentId);
  }

  /** Used by the status chip filter in the console. */
  static readonly STATUSES = Object.values(CampaignStatus);
}
