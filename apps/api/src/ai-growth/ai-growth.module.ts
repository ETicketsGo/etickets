import { Module } from '@nestjs/common';
import { OrganizerAiController } from './organizer-ai.controller';
import { AiAdminController } from './ai-admin.controller';
import { OrganizerAiService } from './organizer-ai.service';
import { ContentService } from './content.service';
import { RiskService } from './risk.service';
import { AiModule } from '../ai/ai.module';
import { ReportsModule } from '../reports/reports.module';
import { AnalyticsModule } from '../analytics/analytics.module';

/**
 * v2.0 AI & Growth feature layer. Composes the AI foundation (gateway/config/usage)
 * with the existing reports + analytics services; every answer is sourced from those
 * authoritative, org-scoped aggregates. Read-only and advisory throughout.
 */
@Module({
  imports: [AiModule, ReportsModule, AnalyticsModule],
  controllers: [OrganizerAiController, AiAdminController],
  providers: [OrganizerAiService, ContentService, RiskService],
})
export class AiGrowthModule {}
