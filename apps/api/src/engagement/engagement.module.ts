import { Module } from '@nestjs/common';
import {
  MeCommunicationConsentController,
  MeFollowingController,
  OrganizerAudienceController,
  PublicUnsubscribeController,
} from './engagement.controller';
import { OrganizerFollowService } from './organizer-follow.service';
import { CommunicationConsentService } from './communication-consent.service';
import { UnsubscribeService } from './unsubscribe.service';
import { AudienceSummaryService } from './audience-summary.service';

/**
 * Customer engagement: following organizers, scoped communication consent, signed
 * unsubscribe links and the organizer's aggregate audience view.
 *
 * Depends only on global modules (Prisma, Audit, Tenancy, Notifications for the existing
 * marketing-consent store and the suppression hash). Exports the consent service and the
 * follow service so a later campaign sender can ask "may I email this person" in one place.
 */
@Module({
  controllers: [
    MeFollowingController,
    MeCommunicationConsentController,
    PublicUnsubscribeController,
    OrganizerAudienceController,
  ],
  providers: [
    OrganizerFollowService,
    CommunicationConsentService,
    UnsubscribeService,
    AudienceSummaryService,
  ],
  exports: [OrganizerFollowService, CommunicationConsentService, AudienceSummaryService],
})
export class EngagementModule {}
