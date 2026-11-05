import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import { CampaignAction, transition, type CampaignStatus } from './campaign-state';

const DAY_MS = 24 * 3600_000;

/**
 * Platform oversight of organizer campaigns: what is going out under our name, how mailbox
 * providers are taking it, and a brake.
 *
 * Read-only apart from `pause`. No recipient, no address, no message body is returned: staff
 * see what an organizer sees about a campaign and the platform-wide rates, nothing more.
 */
@Injectable()
export class CampaignAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(q: { status?: string; organizationId?: string; page: number; pageSize: number }) {
    const where: Prisma.CampaignWhereInput = {
      ...(q.status ? { status: q.status as never } : {}),
      ...(q.organizationId ? { organizationId: q.organizationId } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.campaign.count({ where }),
      this.prisma.campaign.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: {
          id: true,
          organizationId: true,
          name: true,
          subject: true,
          purpose: true,
          status: true,
          scheduledAt: true,
          startedAt: true,
          completedAt: true,
          pausedReason: true,
          counters: true,
          createdAt: true,
        },
      }),
    ]);
    const orgs = await this.prisma.organization.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.organizationId))] } },
      select: { id: true, name: true },
    });
    const name = new Map(orgs.map((o) => [o.id, o.name]));
    return {
      total,
      page: q.page,
      pageSize: q.pageSize,
      items: rows.map((r) => ({ ...r, organizationName: name.get(r.organizationId) ?? null })),
    };
  }

  /**
   * Bounce and complaint rates of campaign mail, over messages ACCEPTED in the window. SES
   * reviews an account at about 5% bounces and 0.1% complaints; the console shows both
   * thresholds beside the figures.
   */
  async health(now = new Date()) {
    const windows = [7, 30];
    const out = [];
    for (const days of windows) {
      const since = new Date(now.getTime() - days * DAY_MS);
      const groups = await this.prisma.campaignRecipient.groupBy({
        by: ['status'],
        where: { acceptedAt: { gte: since } },
        _count: { _all: true },
      });
      const n = (s: string) => groups.find((g) => g.status === s)?._count._all ?? 0;
      const accepted = groups.reduce((a, g) => a + g._count._all, 0);
      out.push({
        days,
        accepted,
        bounced: n('BOUNCED'),
        complained: n('COMPLAINED'),
        bounceRate: accepted ? n('BOUNCED') / accepted : null,
        complaintRate: accepted ? n('COMPLAINED') / accepted : null,
      });
    }
    const sending = await this.prisma.campaign.count({
      where: { status: { in: ['QUEUED', 'SENDING'] } },
    });
    return {
      windows: out,
      thresholds: { bounceRate: 0.05, complaintRate: 0.001 },
      campaignsInFlight: sending,
      generatedAt: now.toISOString(),
    };
  }

  /** Stop a campaign. Only an admin can resume what an admin paused (the organizer cannot). */
  async pause(actorUserId: string, campaignId: string, reason: string, ip?: string | null) {
    const c = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!c)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Campaign not found.', HttpStatus.NOT_FOUND);
    // A scheduled campaign is paused by cancelling its schedule: back to draft, so it cannot fire.
    const action = c.status === 'SCHEDULED' ? CampaignAction.UNSCHEDULE : CampaignAction.PAUSE;
    const r = transition(c.status as CampaignStatus, action);
    if (!r.ok) {
      throw new AppException(ErrorCodes.CAMPAIGN_TRANSITION_INVALID, r.reason, HttpStatus.CONFLICT);
    }
    const moved = await this.prisma.campaign.updateMany({
      where: { id: c.id, status: c.status, version: c.version },
      data: {
        status: r.to as never,
        pausedReason: 'ADMIN',
        ...(action === CampaignAction.UNSCHEDULE ? { scheduledAt: null, confirmedAt: null } : {}),
        version: { increment: 1 },
      },
    });
    if (moved.count !== 1) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'The campaign changed while you were looking at it. Reload and try again.',
        HttpStatus.CONFLICT,
      );
    }
    await this.prisma.campaignEvent.create({
      data: {
        campaignId: c.id,
        type: 'STATUS_CHANGED',
        actorUserId,
        detail: {
          from: c.status,
          to: r.to,
          action: 'ADMIN_PAUSE',
          reason,
        } as Prisma.InputJsonValue,
      },
    });
    await this.audit.record({
      actorUserId,
      organizationId: c.organizationId,
      action: 'CAMPAIGN_PAUSED_BY_ADMIN',
      entityType: 'Campaign',
      entityId: c.id,
      metadata: { from: c.status, to: r.to, reason },
      ip: ip ?? null,
    });
    return { id: c.id, status: r.to };
  }

  /** Lift an admin pause. A paused campaign goes back to QUEUED; an unscheduled one stays a draft. */
  async release(actorUserId: string, campaignId: string, ip?: string | null) {
    const c = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!c)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Campaign not found.', HttpStatus.NOT_FOUND);
    if (c.pausedReason !== 'ADMIN') {
      throw new AppException(
        ErrorCodes.CAMPAIGN_TRANSITION_INVALID,
        'This campaign was not paused by ETicketsGo.',
        HttpStatus.CONFLICT,
      );
    }
    const resume = c.status === 'PAUSED';
    const to = resume ? transition(c.status as CampaignStatus, CampaignAction.RESUME) : null;
    if (to && !to.ok) {
      throw new AppException(
        ErrorCodes.CAMPAIGN_TRANSITION_INVALID,
        to.reason,
        HttpStatus.CONFLICT,
      );
    }
    const moved = await this.prisma.campaign.updateMany({
      where: { id: c.id, status: c.status, version: c.version },
      data: {
        pausedReason: null,
        ...(to && to.ok ? { status: to.to as never } : {}),
        version: { increment: 1 },
      },
    });
    if (moved.count !== 1) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'The campaign changed while you were looking at it. Reload and try again.',
        HttpStatus.CONFLICT,
      );
    }
    await this.audit.record({
      actorUserId,
      organizationId: c.organizationId,
      action: 'CAMPAIGN_RELEASED_BY_ADMIN',
      entityType: 'Campaign',
      entityId: c.id,
      metadata: { from: c.status, to: to && to.ok ? to.to : c.status },
      ip: ip ?? null,
    });
    return { id: c.id, status: to && to.ok ? to.to : c.status };
  }
}
