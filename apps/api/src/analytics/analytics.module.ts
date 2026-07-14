import { Module } from '@nestjs/common';
import { ReportsModule } from '../reports/reports.module';
import { PayoutsModule } from '../payouts/payouts.module';
import { AdminAnalyticsController, AnalyticsController } from './analytics.controller';
import { AdminBusinessReportsController } from './business-reports.controller';
import { AnalyticsService } from './analytics.service';
import { BusinessReportsService } from './business-reports.service';

@Module({
  imports: [ReportsModule, PayoutsModule],
  controllers: [AnalyticsController, AdminAnalyticsController, AdminBusinessReportsController],
  providers: [AnalyticsService, BusinessReportsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
