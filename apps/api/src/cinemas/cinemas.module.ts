import { Module } from '@nestjs/common';
import { CinemasController, ScreensController } from './cinemas.controller';
import { CinemaComplianceService } from './cinema-compliance.service';
import { CinemasService } from './cinemas.service';
import { PilotReadinessService } from './pilot-readiness.service';

@Module({
  controllers: [CinemasController, ScreensController],
  providers: [CinemasService, PilotReadinessService, CinemaComplianceService],
  exports: [CinemasService, PilotReadinessService],
})
export class CinemasModule {}
