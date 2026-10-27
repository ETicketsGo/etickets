import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EngagementModule } from '../engagement/engagement.module';
import {
  AdminCampaignsController,
  OrganizerCampaignsController,
  PublicCampaignLinksController,
} from './campaigns.controller';
import { CampaignsService } from './campaigns.service';
import { CampaignAudienceService } from './campaign-audience.service';
import { CampaignRenderService } from './campaign-render.service';
import { CampaignDispatchService } from './campaign-dispatch.service';
import { CampaignEventsService } from './campaign-events.service';
import { CampaignAnalyticsService } from './campaign-analytics.service';
import { CampaignAdminService } from './campaign-admin.service';
import { CAMPAIGN_TRANSPORT, selectCampaignTransport } from './campaign-transport';

/**
 * Organizer email campaigns: drafts, audiences, delivery, events and analytics.
 *
 * Depends on the global modules (Prisma, Audit, Tenancy, Notifications for the suppression list
 * and the SES event sinks, Billing for entitlements and quota) and on Engagement for consent
 * and unsubscribe links. Nothing depends on it except the worker, which drives
 * `CampaignDispatchService` on its own `campaigns` queue.
 */
@Module({
  imports: [EngagementModule],
  controllers: [
    OrganizerCampaignsController,
    PublicCampaignLinksController,
    AdminCampaignsController,
  ],
  providers: [
    { provide: CAMPAIGN_TRANSPORT, inject: [ConfigService], useFactory: selectCampaignTransport },
    CampaignsService,
    CampaignAudienceService,
    CampaignRenderService,
    CampaignDispatchService,
    CampaignEventsService,
    CampaignAnalyticsService,
    CampaignAdminService,
  ],
  exports: [CampaignDispatchService],
})
export class CampaignsModule {}
