import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CampaignRecipientStatus, Prisma } from '@prisma/client';
import { SuppressionReason } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { SuppressionService } from '../notifications/delivery/suppression.service';
import {
  ProviderEventSinks,
  type ProviderEventInput,
  type ProviderEventSink,
  type SinkOutcome,
} from '../notifications/delivery/provider-event-sinks';
import { CommunicationConsentService } from '../engagement/communication-consent.service';
import { ORGANIZER_PURPOSES } from '../engagement/consent-purpose';
import {
  UnsubscribeHooks,
  type UnsubscribeListener,
  type UnsubscribedEvent,
} from '../engagement/unsubscribe-hooks';
import { allowedCampaignTarget, clickKey, verifyClickToken } from './campaign-links';

/** What a campaign recipient becomes on one SES event, and from which statuses it may. */
interface Mapping {
  to: CampaignRecipientStatus;
  from: CampaignRecipientStatus[];
  event: string;
  /** Feed the platform-wide suppression list (only for the address itself failing). */
  suppress?: SuppressionReason;
}

/**
 * The SES event, by its own type name, as a campaign recipient status.
 *
 *   Delivery       ACCEPTED/DEFERRED -> DELIVERED
 *   DeliveryDelay  ACCEPTED          -> DEFERRED   (SES keeps trying; not a failure)
 *   Bounce         Permanent: -> BOUNCED, and the address is suppressed platform-wide
 *                  Transient: -> BOUNCED for this message only (mailbox full, try another day)
 *   Complaint      -> COMPLAINED, suppressed platform-wide, AND unsubscribed from this
 *                  organizer with consent withdrawn - a person who marks it spam said no.
 *   Reject         -> FAILED (SES refused the content). Not the address's fault: no suppression.
 *
 * Send, Open and Click are ignored: Send is already ACCEPTED, and opens are not tracked
 * (an open pixel is a tracking device, and Apple Mail fakes opens anyway). Clicks come from
 * our own redirect, not from SES.
 */
export function mappingFor(input: {
  providerStatus?: string | null;
  failureCode?: string | null;
}): Mapping | null {
  switch (input.providerStatus) {
    case 'Delivery':
      return { to: 'DELIVERED', from: ['QUEUED', 'ACCEPTED', 'DEFERRED'], event: 'DELIVERED' };
    case 'DeliveryDelay':
      return { to: 'DEFERRED', from: ['ACCEPTED'], event: 'DEFERRED' };
    case 'Bounce':
      return input.failureCode === 'Permanent'
        ? {
            to: 'BOUNCED',
            from: ['QUEUED', 'ACCEPTED', 'DEFERRED', 'DELIVERED'],
            event: 'BOUNCED',
            suppress: SuppressionReason.HARD_BOUNCE,
          }
        : { to: 'BOUNCED', from: ['QUEUED', 'ACCEPTED', 'DEFERRED'], event: 'BOUNCED' };
    case 'Complaint':
      return {
        to: 'COMPLAINED',
        from: ['QUEUED', 'ACCEPTED', 'DEFERRED', 'DELIVERED', 'BOUNCED', 'UNSUBSCRIBED'],
        event: 'COMPLAINED',
        suppress: SuppressionReason.COMPLAINT,
      };
    case 'Reject':
    case 'RenderingFailure':
      return { to: 'FAILED', from: ['QUEUED', 'ACCEPTED', 'DEFERRED'], event: 'REJECTED' };
    default:
      return null;
  }
}

/**
 * Everything that happens to a campaign message after it is sent: provider events, clicks
 * and unsubscribes. Registered with the notification webhook's sinks and with the
 * unsubscribe hooks at start-up.
 */
@Injectable()
export class CampaignEventsService implements ProviderEventSink, UnsubscribeListener, OnModuleInit {
  private readonly logger = new Logger('CampaignEvents');

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly suppression: SuppressionService,
    private readonly consent: CommunicationConsentService,
    private readonly sinks: ProviderEventSinks,
    private readonly hooks: UnsubscribeHooks,
  ) {}

  onModuleInit(): void {
    this.sinks.register(this);
    this.hooks.register(this);
  }

  // ── Provider events ───────────────────────────────────────────────────────────

  async apply(input: ProviderEventInput): Promise<SinkOutcome> {
    if (input.provider !== 'ses') return 'unknown';
    const r = await this.prisma.campaignRecipient.findFirst({
      where: { provider: 'ses', providerMessageId: input.providerMessageId },
    });
    if (!r) return 'unknown';
    const mapping = mappingFor(input);
    if (!mapping) return 'ignored';

    // The provider's event id is the idempotency key: a replayed notification is one row.
    const eventKey = input.eventId ? `ses:${input.eventId}` : null;
    const created = await this.prisma.campaignEvent.createMany({
      data: [
        {
          campaignId: r.campaignId,
          recipientId: r.id,
          type: mapping.event,
          providerEventId: eventKey,
          occurredAt: input.occurredAt ?? new Date(),
          detail: {
            providerStatus: input.providerStatus ?? null,
            failureCode: input.failureCode ?? null,
          } as Prisma.InputJsonValue,
        },
      ],
      skipDuplicates: true,
    });
    if (eventKey && created.count === 0) return 'ignored';

    const at = input.occurredAt ?? new Date();
    if (mapping.from.includes(r.status)) {
      await this.prisma.campaignRecipient.updateMany({
        where: { id: r.id, status: { in: mapping.from } },
        data: {
          status: mapping.to,
          finalAt: at,
          ...(mapping.to === 'DELIVERED' || mapping.to === 'COMPLAINED'
            ? { deliveredAt: r.deliveredAt ?? at }
            : {}),
          ...(mapping.to === 'FAILED' ? { failedAt: at } : {}),
        },
      });
    }

    if (mapping.suppress) {
      await this.suppression.suppress({
        channel: 'email',
        destinationRef: { hashes: { email: r.emailHash }, mask: r.destinationMask },
        reason: mapping.suppress,
        provider: 'ses',
      });
    }
    if (mapping.to === 'COMPLAINED') await this.complaintStopsOrganizer(r);
    return 'applied';
  }

  /**
   * A complaint is the strongest "no" there is. This organizer may not mail the address
   * again, and the consent rows say so as well, so the person's account shows the truth.
   */
  private async complaintStopsOrganizer(r: {
    organizationId: string;
    emailHash: string;
    userId: string | null;
  }) {
    await this.prisma.organizerSuppression.upsert({
      where: {
        organizationId_channel_destinationHash: {
          organizationId: r.organizationId,
          channel: 'email',
          destinationHash: r.emailHash,
        },
      },
      create: {
        organizationId: r.organizationId,
        channel: 'email',
        destinationHash: r.emailHash,
        reason: SuppressionReason.COMPLAINT,
      },
      update: { liftedAt: null, reason: SuppressionReason.COMPLAINT },
    });
    if (!r.userId) return;
    const user = await this.prisma.user.findUnique({
      where: { id: r.userId },
      select: { email: true },
    });
    if (!user) return;
    for (const purpose of ORGANIZER_PURPOSES) {
      await this.consent.record(
        { userId: r.userId, email: user.email },
        { purpose, organizationId: r.organizationId, granted: false },
        { source: 'campaign-complaint', actorUserId: null },
      );
    }
  }

  // ── Unsubscribes ──────────────────────────────────────────────────────────────

  /**
   * Shown against the most recent campaign this organizer sent the person. The unsubscribe
   * itself (consent withdrawn, organizer suppression) has already happened; this is reporting.
   */
  async onUnsubscribed(e: UnsubscribedEvent): Promise<void> {
    if (e.scope !== 'organizer' || !e.organizationId) return;
    const since = new Date(e.at.getTime() - 60 * 24 * 3600_000);
    const r = await this.prisma.campaignRecipient.findFirst({
      where: {
        organizationId: e.organizationId,
        emailHash: e.emailHash,
        status: { in: ['ACCEPTED', 'DELIVERED', 'DEFERRED'] },
        acceptedAt: { gte: since },
      },
      orderBy: { acceptedAt: 'desc' },
    });
    if (!r) return;
    await this.prisma.campaignRecipient.update({
      where: { id: r.id },
      data: { status: 'UNSUBSCRIBED', finalAt: e.at, deliveredAt: r.deliveredAt ?? e.at },
    });
    await this.prisma.campaignEvent.create({
      data: {
        campaignId: r.campaignId,
        recipientId: r.id,
        type: 'UNSUBSCRIBED',
        occurredAt: e.at,
        detail: { oneClick: e.oneClick } as Prisma.InputJsonValue,
      },
    });
  }

  // ── Clicks ────────────────────────────────────────────────────────────────────

  /**
   * Where a tracked link goes, recording the click on the way.
   *
   * Returns null for a token that is malformed, tampered with, or names a link that is not
   * there; the controller then sends the person to the storefront home page rather than an
   * error, since a broken link in an old email is not their fault.
   */
  async click(token: string, now = new Date()): Promise<string | null> {
    const claims = verifyClickToken(token, clickKey(this.config));
    if (!claims) return null;
    const link = await this.prisma.campaignLink.findUnique({ where: { id: claims.linkId } });
    if (!link) return null;
    // Checked again here: an allowlist that changed since the send still applies.
    const target = allowedCampaignTarget(this.config, link.targetUrl);
    if (!target) return null;
    const recipient = await this.prisma.campaignRecipient.findFirst({
      where: { id: claims.recipientId, campaignId: link.campaignId },
      select: { id: true },
    });
    if (!recipient) return target;
    try {
      const first = await this.prisma.campaignClick.createMany({
        data: [
          {
            campaignId: link.campaignId,
            linkId: link.id,
            recipientId: recipient.id,
            firstClickedAt: now,
            lastClickedAt: now,
          },
        ],
        skipDuplicates: true,
      });
      if (first.count === 0) {
        await this.prisma.campaignClick.updateMany({
          where: { linkId: link.id, recipientId: recipient.id },
          data: { clicks: { increment: 1 }, lastClickedAt: now },
        });
      } else {
        await this.prisma.campaignEvent.create({
          data: {
            campaignId: link.campaignId,
            recipientId: recipient.id,
            type: 'CLICKED',
            occurredAt: now,
            detail: { linkId: link.id } as Prisma.InputJsonValue,
          },
        });
      }
    } catch (err) {
      // Recording a click must never stop the person reaching the page.
      this.logger.warn(`click not recorded: ${(err as Error)?.name ?? 'Error'}`);
    }
    return target;
  }
}
