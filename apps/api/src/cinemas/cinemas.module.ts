import { Module } from '@nestjs/common';
import { CinemasController, ScreensController } from './cinemas.controller';
import { CinemaComplianceService } from './cinema-compliance.service';
import { CinemasService } from './cinemas.service';
import { PilotReadinessService } from './pilot-readiness.service';
import { PricingModule } from '../pricing/pricing.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  // CinemaComplianceService reads the SAME resolver checkout uses (PricingModule) and
  // answers only for cinemas the caller belongs to (TenancyModule).
  imports: [PricingModule, TenancyModule, AuditModule],
  controllers: [CinemasController, ScreensController],
  providers: [CinemasService, PilotReadinessService, CinemaComplianceService],
  exports: [CinemasService, PilotReadinessService],
})
export class CinemasModule {}
