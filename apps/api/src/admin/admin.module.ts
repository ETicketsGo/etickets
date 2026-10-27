import { Module } from '@nestjs/common';
import { AdminStaffController } from './admin-staff.controller';
import { AdminStaffService } from './admin-staff.service';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';
import { AdminController } from './admin.controller';
import { AdminBookingViewController } from './admin-booking-view.controller';
import { TaxRulesService } from './tax-rules.service';
import { CinemaPricingPoliciesService } from './cinema-pricing-policies.service';
import { AdminService } from './admin.service';
import { AdminGroupingService } from './admin-grouping.service';
import { PlatformFeePoliciesController } from './platform-fee-policies.controller';
import { PlatformFeePoliciesService } from './platform-fee-policies.service';
import { PricingModule } from '../pricing/pricing.module';
import { FirstAdminBootstrap } from './first-admin.bootstrap';
import { AuthModule } from '../auth/auth.module';
import { MoviesModule } from '../movies/movies.module';
import { BookingsModule } from '../bookings/bookings.module';
// For the one invitation implementation — the staff screen must not grow its own.
import { OrganizationsModule } from '../organizations/organizations.module';

@Module({
  imports: [MoviesModule, OrganizationsModule, BookingsModule, AuthModule, PricingModule],
  controllers: [
    AdminController,
    AdminBookingViewController,
    AdminStaffController,
    AdminUsersController,
    PlatformFeePoliciesController,
  ],
  providers: [
    AdminService,
    AdminGroupingService,
    AdminStaffService,
    AdminUsersService,
    FirstAdminBootstrap,
    TaxRulesService,
    CinemaPricingPoliciesService,
    PlatformFeePoliciesService,
  ],
})
export class AdminModule {}
