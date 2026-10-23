import { Module } from '@nestjs/common';
import { CrmController, CrmReportsController, CrmTeamsController } from './crm.controller';
import { CrmScopeService } from './crm-scope.service';
import { CrmLeadsService } from './crm-leads.service';
import { CrmActivitiesService } from './crm-activities.service';
import { CrmImportService } from './crm-import.service';
import { CrmTeamsService } from './crm-teams.service';
import { CrmReportsService } from './crm-reports.service';

/**
 * Organizer acquisition (sales CRM) inside the admin console.
 *
 * Self-contained: it depends only on the global Prisma and Audit modules, reads Organization
 * and Event rows for derived metrics, and writes only its own Crm* tables. Nothing else in the
 * API imports it.
 */
@Module({
  controllers: [CrmController, CrmTeamsController, CrmReportsController],
  providers: [
    CrmScopeService,
    CrmLeadsService,
    CrmActivitiesService,
    CrmImportService,
    CrmTeamsService,
    CrmReportsService,
  ],
})
export class CrmModule {}
