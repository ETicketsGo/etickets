import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { legalEntityFor } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { redirectUrl } from '../common/console-urls';
import { contentSchema, eventIdsIn, type CampaignContent } from './campaign-content';
import { renderCampaignEmail, type RenderEvent, type RenderedCampaign } from './campaign-email';
import { allowedCampaignTarget, apiBase } from './campaign-links';
import { campaignFooterAddress } from './campaign-sending-config';

/** The campaign fields the renderer reads. */
export interface RenderableCampaign {
  id: string;
  organizationId: string;
  subject: string;
  previewText: string | null;
  purpose: string;
  content: unknown;
  eventId: string | null;
  locale: string;
}

/** Everything about the organizer and the events a campaign shows, loaded once per campaign. */
export interface RenderContext {
  content: CampaignContent;
  organizer: { name: string; logoUrl: string | null; country: string | null };
  mainEventImageUrl: string | null;
  events: Record<string, RenderEvent>;
}

/**
 * Turns a stored campaign into the email a person receives (or the preview an organizer sees).
 *
 * Loads only rows of the campaign's own organization: an event block naming somebody else's
 * event renders nothing, even if the id was stored before an ownership check existed.
 */
@Injectable()
export class CampaignRenderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** An API path (`/public/...`) or an owned absolute URL, as an absolute URL, or null. */
  private absoluteImage(pathOrUrl: string | null | undefined): string | null {
    if (!pathOrUrl) return null;
    if (pathOrUrl.startsWith('/')) return `${apiBase(this.config)}${pathOrUrl}`;
    return allowedCampaignTarget(this.config, pathOrUrl);
  }

  async context(campaign: RenderableCampaign): Promise<RenderContext> {
    const content = contentSchema.parse(campaign.content);
    const org = await this.prisma.organization.findUnique({
      where: { id: campaign.organizationId },
      select: { name: true, logoUrl: true, registeredCountry: true },
    });
    const ids = [
      ...new Set([...eventIdsIn(content), ...(campaign.eventId ? [campaign.eventId] : [])]),
    ];
    const events = ids.length
      ? await this.prisma.event.findMany({
          where: { id: { in: ids }, organizationId: campaign.organizationId },
          select: {
            id: true,
            title: true,
            slug: true,
            venue: { select: { name: true, city: true, timezone: true } },
            sessions: {
              where: { startsAt: { gt: new Date() }, status: { not: 'CANCELLED' } },
              orderBy: { startsAt: 'asc' },
              take: 1,
              select: { startsAt: true },
            },
            images: { orderBy: { position: 'asc' }, take: 1, select: { sha256: true } },
          },
        })
      : [];
    const byId: Record<string, RenderEvent> = {};
    let mainEventImageUrl: string | null = null;
    for (const e of events) {
      const imageUrl = e.images[0]
        ? `${apiBase(this.config)}/public/events/${e.id}/image?v=${e.images[0].sha256.slice(0, 16)}`
        : null;
      if (e.id === campaign.eventId) mainEventImageUrl = imageUrl;
      const startsAt = e.sessions[0]?.startsAt ?? null;
      byId[e.id] = {
        title: e.title,
        when: startsAt ? formatWhen(startsAt, e.venue?.timezone ?? 'UTC', campaign.locale) : null,
        venue: e.venue ? [e.venue.name, e.venue.city].filter(Boolean).join(', ') : null,
        imageUrl,
        bookUrl: redirectUrl(this.config, {
          site: 'customer',
          path: `/events/${encodeURIComponent(e.slug)}`,
          purpose: 'campaign event link',
        }),
      };
    }
    return {
      content,
      organizer: {
        name: org?.name ?? 'Organizer',
        logoUrl: this.absoluteImage(org?.logoUrl),
        country: org?.registeredCountry ?? null,
      },
      mainEventImageUrl,
      events: byId,
    };
  }

  render(
    campaign: RenderableCampaign,
    ctx: RenderContext,
    opts: {
      link: (target: string) => string | null;
      unsubscribeUrl: string;
      unsubscribeAllUrl: string;
      isTest?: boolean;
    },
  ): RenderedCampaign {
    // The address of the entity the footer names, for the organizer's country. A live
    // environment without it refuses here too, as the last line behind review and dispatch.
    const footer = campaignFooterAddress(this.config, ctx.organizer.country);
    if (footer.refusal) throw new Error(footer.refusal);
    const entity = legalEntityFor(ctx.organizer.country);
    return renderCampaignEmail({
      locale: campaign.locale,
      subject: campaign.subject,
      previewText: campaign.previewText,
      blocks: ctx.content.blocks,
      purpose: campaign.purpose,
      organizer: { name: ctx.organizer.name, logoUrl: ctx.organizer.logoUrl },
      mainEventImageUrl: ctx.mainEventImageUrl,
      events: ctx.events,
      // Every link is checked against the owned hosts again here, whatever was saved.
      link: (target) => {
        const allowed = allowedCampaignTarget(this.config, target);
        return allowed ? opts.link(allowed) : null;
      },
      unsubscribeUrl: opts.unsubscribeUrl,
      unsubscribeAllUrl: opts.unsubscribeAllUrl,
      platform: { legalName: entity.legalName, postalAddress: footer.address },
      isTest: opts.isTest,
    });
  }
}

function formatWhen(at: Date, zone: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale === 'fr-CA' ? 'fr-CA' : 'en-GB', {
      timeZone: zone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(at);
  } catch {
    return at.toISOString();
  }
}
