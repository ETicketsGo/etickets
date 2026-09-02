import { Module } from '@nestjs/common';
import { AdminStaffController } from './admin-staff.controller';
import { AdminStaffService } from './admin-staff.service';
import { AdminController } from './admin.controller';
import { TaxRulesService } from './tax-rules.service';
import { AdminService } from './admin.service';
import { MoviesModule } from '../movies/movies.module';
// For the one invitation implementation — the staff screen must not grow its own.
import { OrganizationsModule } from '../organizations/organizations.module';

@Module({
  imports: [MoviesModule, OrganizationsModule],
  controllers: [AdminController, AdminStaffController],
  providers: [AdminService, AdminStaffService, TaxRulesService],
})
export class AdminModule {}
