import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Campaign, Prisma } from '@prisma/client';
import { EntitlementKey } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { EntitlementService } from '../billing/entitlements/entitlement.service';
import { currentConsent } from '../engagement/consent-purpose';
import { ALL_ORGANIZER_PURPOSES, buildUnsubscribeLinks } from '../engagement/unsubscribe-token';
import { audienceSchema } from './campaign-audience';
import { CampaignAudienceService } from './campaign-audience.service';
import { CampaignRenderService, type RenderContext } from './campaign-render.service';
import { clickKey, clickUrl, signClickToken } from './campaign-links';
import {
  CampaignAction,
  transition,
  type CampaignStatus,
  type RecipientCounts,
} from './campaign-state';
import { isQuietTime, type QuietHours } from './quiet-hours';
import { campaignFromHeader, campaignSendingConfig } from './campaign-sending-config';
import {
  CAMPAIGN_TRANSPORT,
  classifySendError,
  sendErrorSummary,
  type CampaignTransport,
} from './campaign-transport';

const QUOTA_KEY = EntitlementKey.CAMPAIGNS_MONTHLY_EMAIL_QUOTA;
/** Written before the provider is called. Seen again on a rerun, it means "outcome unknown". */
export const IN_FLIGHT = 'IN_FLIGHT';
/** A QUEUED recipient with no progress for this long is put back on the queue. */
const REQUEUE_AFTER_MS = 2 * 60_000;

export type SendOutcome =
  | 'accepted'
  | 'rejected'
  | 'retry'
  | 'failed'
  | 'skipped_consent'
  | 'skipped_suppressed'
  | 'not_sending'
  | 'already_final'
  | 'quiet_hours'
  | 'disabled'
  | 'quota_exhausted'
  | 'provider_paused'
  | 'unknown_outcome';

export interface TickResult {
  promoted: number;
  /** Campaigns whose recipients must be materialised (one expand job each). */
  expand: string[];
  /** Recipient ids to put on the send queue. Each job id is the recipient id: no duplicates. */
  send: string[];
  finished: number;
}

/** Thrown for a transient failure, so the queue retries with backoff. */
export class RetryableSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableSendError';
  }
}

/**
 * The campaign delivery pipeline. Called by the worker's dedicated `campaigns` queue; every
 * method is safe to run twice, concurrently, or after a crash.
 *
 *   tick       promote due SCHEDULED campaigns; ask for an expand of each QUEUED one; for each
 *              SENDING one, move a window of PENDING recipients to QUEUED and hand back their
 *              ids to enqueue; finish the ones with nobody left to send to.
 *   expand     materialise the recipients (idempotent, batched), then QUEUED -> SENDING.
 *   sendOne    one recipient: re-check consent and both suppression lists NOW, check the quota,
 *              send, and spend one credit only when the provider ACCEPTED it.
 *
 * ── WHY A WINDOW, NOT THE WHOLE LIST ────────────────────────────────────────────────
 * Only about a minute of work is on the queue at a time. A pause therefore leaves at most a
 * minute of jobs behind, and each of those sees the campaign is not SENDING and does nothing.
 * A list of ten thousand jobs would need ten thousand no-ops, at the rate limit, before a
 * second campaign could move.
 */
@Injectable()
export class CampaignDispatchService {
  private readonly logger = new Logger('CampaignDispatch');
  private readonly contexts = new Map<
    string,
    { at: number; version: number; ctx: RenderContext }
  >();
  private readonly linkIds = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementService,
    private readonly audience: CampaignAudienceService,
    private readonly renderer: CampaignRenderService,
    @Inject(CAMPAIGN_TRANSPORT) private readonly transport: CampaignTransport,
  ) {}

  private sendingEnabled(): boolean {
    return !campaignSendingConfig(this.config).refusal;
  }

  /** How many recipients may be queued at once per campaign: about a minute of sending. */
  private window(): number {
    return Math.max(10, campaignSendingConfig(this.config).ratePerSecond * 60);
  }

  // ── tick ──────────────────────────────────────────────────────────────────────

  async tick(now = new Date()): Promise<TickResult> {
    const result: TickResult = { promoted: 0, expand: [], send: [], finished: 0 };
    if (!this.sendingEnabled()) return result;

    const due = await this.prisma.campaign.findMany({
      where: { status: 'SCHEDULED', scheduledAt: { lte: now } },
      select: { id: true, status: true, version: true },
      take: 50,
    });
    for (const c of due) {
      if (await this.systemMove(c, CampaignAction.PROMOTE, { queuedAt: now })) result.promoted += 1;
    }

    const queued = await this.prisma.campaign.findMany({
      where: { status: 'QUEUED' },
      select: { id: true },
      take: 50,
    });
    result.expand.push(...queued.map((c) => c.id));

    const sending = await this.prisma.campaign.findMany({
      where: { status: 'SENDING' },
      take: 50,
    });
    for (const c of sending) {
      const counts = await this.counts(c.id);
      await this.prisma.campaign
        .updateMany({ where: { id: c.id }, data: { counters: counts as Prisma.InputJsonValue } })
        .catch(() => undefined);
      if ((counts.PENDING ?? 0) + (counts.QUEUED ?? 0) === 0) {
        if (await this.finish(c, counts)) result.finished += 1;
        continue;
      }
      // Quiet hours hold the queue: nothing new goes out until they end.
      if (isQuietTime(now, c.timezone, c.quietHours as QuietHours | null)) continue;
      result.send.push(...(await this.pump(c.id, now)));
    }
    return result;
  }

  /** Claim up to a window of PENDING recipients, and re-offer the QUEUED ones that stalled. */
  async pump(campaignId: string, now = new Date()): Promise<string[]> {
    const window = this.window();
    const inFlight = await this.prisma.campaignRecipient.count({
      where: { campaignId, status: 'QUEUED' },
    });
    const room = Math.max(0, window - inFlight);
    const claimed = room
      ? await this.prisma.$queryRaw<{ id: string }[]>`
          UPDATE "CampaignRecipient" SET status = 'QUEUED', "queuedAt" = ${now}, "updatedAt" = ${now}
          WHERE id IN (
            SELECT id FROM "CampaignRecipient"
            WHERE "campaignId" = ${campaignId} AND status = 'PENDING'
            ORDER BY id LIMIT ${room}
            FOR UPDATE SKIP LOCKED
          )
          RETURNING id`
      : [];
    // Re-offer stalled ones: a job no-op'd by a pause, or lost with a crashed worker. The job id
    // is the recipient id, so one still waiting on the queue is not added twice.
    const stalled = await this.prisma.campaignRecipient.findMany({
      where: {
        campaignId,
        status: 'QUEUED',
        updatedAt: { lt: new Date(now.getTime() - REQUEUE_AFTER_MS) },
      },
      select: { id: true },
      take: window,
    });
    return [...claimed.map((r) => r.id), ...stalled.map((r) => r.id)];
  }

  async counts(campaignId: string): Promise<RecipientCounts> {
    const rows = await this.prisma.campaignRecipient.groupBy({
      by: ['status'],
      where: { campaignId },
      _count: { _all: true },
    });
    const out: RecipientCounts = {};
    for (const r of rows) out[r.status as keyof RecipientCounts] = r._count._all;
    return out;
  }

  private async finish(c: Campaign, counts: RecipientCounts): Promise<boolean> {
    const r = transition(c.status as CampaignStatus, CampaignAction.FINISH, counts);
    if (!r.ok) return false;
    const moved = await this.prisma.campaign.updateMany({
      where: { id: c.id, status: c.status },
      data: {
        status: r.to as never,
        completedAt: new Date(),
        counters: counts as Prisma.InputJsonValue,
        version: { increment: 1 },
      },
    });
    if (moved.count !== 1) return false;
    await this.event(c.id, null, 'STATUS_CHANGED', {
      from: c.status,
      to: r.to,
      action: 'FINISH',
      counts,
    });
    return true;
  }

  /** A worker-driven move, guarded on status like every other. */
  private async systemMove(
    c: { id: string; status: string },
    action: CampaignAction,
    data: Prisma.CampaignUpdateManyMutationInput,
    detail: Record<string, unknown> = {},
  ): Promise<boolean> {
    const r = transition(c.status as CampaignStatus, action);
    if (!r.ok) return false;
    const moved = await this.prisma.campaign.updateMany({
      where: { id: c.id, status: c.status as never },
      data: { ...data, status: r.to as never, version: { increment: 1 } },
    });
    if (moved.count !== 1) return false;
    await this.event(c.id, null, 'STATUS_CHANGED', { from: c.status, to: r.to, action, ...detail });
    return true;
  }

  // ── expand ────────────────────────────────────────────────────────────────────

  async expand(campaignId: string): Promise<{ inserted: number; started: boolean }> {
    if (!this.sendingEnabled()) return { inserted: 0, started: false };
    const c = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!c || c.status !== 'QUEUED') return { inserted: 0, started: false };
    const def = await this.audience.resolve(c.organizationId, audienceSchema.parse(c.audience));
    const inserted = await this.audience.materialise(c, def);
    // The status may have changed (paused, cancelled) while we materialised: START is guarded.
    const started = await this.systemMove(
      c,
      CampaignAction.START,
      { startedAt: c.startedAt ?? new Date() },
      {
        materialised: inserted,
      },
    );
    return { inserted, started };
  }

  // ── sendOne ───────────────────────────────────────────────────────────────────

  async sendOne(
    recipientId: string,
    opts: { finalAttempt: boolean } = { finalAttempt: true },
  ): Promise<SendOutcome> {
    const sending = campaignSendingConfig(this.config);
    if (sending.refusal) return 'disabled';
    const r = await this.prisma.campaignRecipient.findUnique({ where: { id: recipientId } });
    if (!r) return 'already_final';
    const c = await this.prisma.campaign.findUnique({ where: { id: r.campaignId } });
    if (!c || c.status !== 'SENDING') return 'not_sending';
    if (r.status !== 'QUEUED') return 'already_final';
    if (isQuietTime(new Date(), c.timezone, c.quietHours as QuietHours | null))
      return 'quiet_hours';

    // An earlier run reached the provider and then lost track. Sending again might send twice:
    // for marketing mail, once at most beats at least once.
    if (r.lastError === IN_FLIGHT) {
      await this.finalise(r.id, 'FAILED', {
        lastError: 'Outcome unknown: the worker stopped mid-send.',
      });
      await this.event(c.id, r.id, 'FAILED', { reason: 'UNKNOWN_OUTCOME' });
      return 'unknown_outcome';
    }
    if (!r.destination) {
      await this.finalise(r.id, 'FAILED', { lastError: 'No address on file.' });
      return 'failed';
    }

    // ── Consent and suppression, NOW, not when the list was built. ──
    const block = await this.blockedNow(c, r);
    if (block) {
      await this.finalise(r.id, block, {});
      await this.event(c.id, r.id, 'SKIPPED', { reason: block });
      return block === 'SKIPPED_CONSENT' ? 'skipped_consent' : 'skipped_suppressed';
    }

    // ── Quota: look before sending, spend only after the provider accepts. ──
    const left = await this.entitlements.remaining(c.organizationId, QUOTA_KEY);
    if (left.remaining < 1) {
      await this.pauseBySystem(c, 'QUOTA_EXHAUSTED');
      return 'quota_exhausted';
    }

    // Mark the attempt before calling out. Conditional, so two workers cannot both send.
    const claim = await this.prisma.campaignRecipient.updateMany({
      where: {
        id: r.id,
        status: 'QUEUED',
        OR: [{ lastError: null }, { lastError: { not: IN_FLIGHT } }],
      },
      data: { attempts: { increment: 1 }, lastError: IN_FLIGHT },
    });
    if (claim.count !== 1) return 'already_final';

    let message;
    try {
      const ctx = await this.contextFor(c);
      const links = buildUnsubscribeLinks(this.config, {
        userId: r.userId,
        email: r.destination,
        scope: 'organizer',
        organizationId: c.organizationId,
        purpose: ALL_ORGANIZER_PURPOSES,
      });
      const key = clickKey(this.config);
      const linkIds = await this.ensureLinks(c.id, ctx);
      const rendered = this.renderer.render(c, ctx, {
        link: (target) => {
          const linkId = linkIds.get(target);
          return linkId
            ? clickUrl(this.config, signClickToken({ linkId, recipientId: r.id }, key))
            : null;
        },
        unsubscribeUrl: links.pageUrl,
      });
      message = {
        to: r.destination,
        from: campaignFromHeader(c.senderName, sending.fromAddress!),
        replyTo: c.replyTo,
        subject: c.subject,
        html: rendered.html,
        text: rendered.text,
        configurationSet: sending.configurationSet,
        listUnsubscribe: links.headers,
      };
    } catch (err) {
      // A render or config problem is ours, not the recipient's; nothing was sent.
      await this.finalise(r.id, 'FAILED', { lastError: sendErrorSummary(err) });
      await this.event(c.id, r.id, 'FAILED', { reason: 'RENDER' });
      return 'failed';
    }

    let accepted: { provider: string; providerMessageId: string };
    try {
      accepted = await this.transport.send(message);
    } catch (err) {
      const kind = classifySendError(err);
      const summary = sendErrorSummary(err);
      if (kind === 'REJECTED') {
        await this.finalise(r.id, 'FAILED', { lastError: summary });
        await this.event(c.id, r.id, 'REJECTED', { error: (err as Error)?.name ?? 'Error' });
        return 'rejected';
      }
      if (kind === 'ACCOUNT') {
        // Not this person's fault: put them back and stop the campaign.
        await this.prisma.campaignRecipient.update({
          where: { id: r.id },
          data: { lastError: summary, attempts: { decrement: 1 } },
        });
        await this.pauseBySystem(c, `PROVIDER_REFUSED:${(err as Error)?.name ?? 'Error'}`);
        return 'provider_paused';
      }
      if (opts.finalAttempt) {
        await this.finalise(r.id, 'FAILED', { lastError: summary });
        await this.event(c.id, r.id, 'FAILED', { reason: 'RETRIES_EXHAUSTED' });
        return 'failed';
      }
      await this.prisma.campaignRecipient.update({
        where: { id: r.id },
        data: { lastError: summary },
      });
      throw new RetryableSendError(summary);
    }

    const now = new Date();
    await this.prisma.campaignRecipient.update({
      where: { id: r.id },
      data: {
        status: 'ACCEPTED',
        provider: accepted.provider,
        providerMessageId: accepted.providerMessageId,
        acceptedAt: now,
        lastError: null,
        // Minimised: the provider has it now, and bounces arrive with their own copy.
        destination: null,
      },
    });
    await this.event(c.id, r.id, 'ACCEPTED', { provider: accepted.provider });
    try {
      await this.entitlements.consume(
        c.organizationId,
        QUOTA_KEY,
        1,
        `campaign-recipient:${r.id}`,
        {
          refType: 'CampaignRecipient',
          refId: r.id,
        },
      );
    } catch (err) {
      // Two sends raced for the last credit and the provider took both. Recorded, and the
      // campaign stops so it cannot happen again.
      this.logger.warn(`campaign ${c.id}: credit not spent after accept (${(err as Error)?.name})`);
      await this.event(c.id, r.id, 'QUOTA_OVERRUN', {});
      await this.pauseBySystem(c, 'QUOTA_EXHAUSTED');
    }
    return 'accepted';
  }

  /**
   * Why this person must not get it now, or null.
   *
   * Fails CLOSED, unlike the transactional suppression check: if the database cannot answer
   * "may we send this person marketing", the answer is no - this method throws and the job is
   * retried later, and nothing is sent in between.
   */
  private async blockedNow(
    c: Campaign,
    r: { userId: string | null; emailHash: string },
  ): Promise<'SKIPPED_CONSENT' | 'SKIPPED_SUPPRESSED' | null> {
    if (r.userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: r.userId },
        select: { status: true },
      });
      if (!user || user.status !== 'ACTIVE') return 'SKIPPED_CONSENT';
    }
    const rows = await this.prisma.communicationConsent.findMany({
      where: {
        organizationId: c.organizationId,
        purpose: c.purpose,
        channel: 'email',
        OR: [...(r.userId ? [{ userId: r.userId }] : []), { subjectHash: r.emailHash }],
      },
      select: {
        purpose: true,
        organizationId: true,
        channel: true,
        granted: true,
        source: true,
        policyVersion: true,
        createdAt: true,
      },
    });
    if (!currentConsent(rows, c.purpose, c.organizationId).granted) return 'SKIPPED_CONSENT';
    const [orgBlock, globalBlock] = await Promise.all([
      this.prisma.organizerSuppression.findFirst({
        where: {
          organizationId: c.organizationId,
          channel: 'email',
          destinationHash: r.emailHash,
          liftedAt: null,
        },
        select: { id: true },
      }),
      this.prisma.suppressedDestination.findFirst({
        where: {
          channel: 'email',
          destinationHash: r.emailHash,
          liftedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: { id: true },
      }),
    ]);
    return orgBlock || globalBlock ? 'SKIPPED_SUPPRESSED' : null;
  }

  private async finalise(
    recipientId: string,
    status: 'FAILED' | 'SKIPPED_CONSENT' | 'SKIPPED_SUPPRESSED',
    data: { lastError?: string },
  ) {
    const now = new Date();
    await this.prisma.campaignRecipient.update({
      where: { id: recipientId },
      data: {
        status,
        lastError: data.lastError ?? null,
        destination: null,
        finalAt: now,
        ...(status === 'FAILED' ? { failedAt: now } : {}),
      },
    });
  }

  async pauseBySystem(c: { id: string; status: string; organizationId: string }, reason: string) {
    const r = transition(c.status as CampaignStatus, CampaignAction.PAUSE);
    if (!r.ok) return false;
    const moved = await this.prisma.campaign.updateMany({
      where: { id: c.id, status: { in: ['QUEUED', 'SENDING'] } },
      data: { status: 'PAUSED', pausedReason: reason.slice(0, 120), version: { increment: 1 } },
    });
    if (moved.count !== 1) return false;
    await this.event(c.id, null, 'PAUSED_BY_SYSTEM', { reason });
    await this.audit.record({
      actorUserId: null,
      organizationId: c.organizationId,
      action: 'CAMPAIGN_PAUSED_BY_SYSTEM',
      entityType: 'Campaign',
      entityId: c.id,
      metadata: { reason },
    });
    return true;
  }

  /** The render context, kept for a minute per campaign version: one load per batch, not per mail. */
  private async contextFor(c: Campaign): Promise<RenderContext> {
    const hit = this.contexts.get(c.id);
    if (hit && hit.version === c.version && Date.now() - hit.at < 60_000) return hit.ctx;
    const ctx = await this.renderer.context(c);
    this.contexts.set(c.id, { at: Date.now(), version: c.version, ctx });
    if (this.contexts.size > 200) this.contexts.delete(this.contexts.keys().next().value!);
    return ctx;
  }

  /** One CampaignLink row per distinct target, so the email carries an id, not the URL. */
  private async ensureLinks(campaignId: string, ctx: RenderContext): Promise<Map<string, string>> {
    const targets = new Set<string>();
    for (const b of ctx.content.blocks) {
      if (b.type === 'button') targets.add(b.url);
      if (b.type === 'event' && ctx.events[b.eventId]) targets.add(ctx.events[b.eventId].bookUrl);
    }
    const out = new Map<string, string>();
    for (const raw of targets) {
      // The renderer normalises a target through `new URL`, so the key must be the same form.
      let target: string;
      try {
        target = new URL(raw).toString();
      } catch {
        continue;
      }
      const cacheKey = `${campaignId}|${target}`;
      let id = this.linkIds.get(cacheKey);
      if (!id) {
        const row = await this.prisma.campaignLink.upsert({
          where: { campaignId_targetUrl: { campaignId, targetUrl: target } },
          create: { campaignId, targetUrl: target },
          update: {},
          select: { id: true },
        });
        id = row.id;
        this.linkIds.set(cacheKey, id);
        if (this.linkIds.size > 5000) this.linkIds.delete(this.linkIds.keys().next().value!);
      }
      out.set(target, id);
    }
    return out;
  }

  private async event(
    campaignId: string,
    recipientId: string | null,
    type: string,
    detail: Record<string, unknown>,
  ) {
    await this.prisma.campaignEvent.create({
      data: { campaignId, recipientId, type, detail: detail as Prisma.InputJsonValue },
    });
  }
}
