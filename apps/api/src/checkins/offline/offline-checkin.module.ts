import { Module } from '@nestjs/common';
import { OfflineCheckinController } from './offline-checkin.controller';
import { OfflineManifestService } from './offline-manifest.service';
import { CheckInDeviceService } from './checkin-device.service';
import { OfflineReconciliationService } from './offline-reconciliation.service';
import { OfflineCheckinReadinessService } from './offline-readiness.service';

/**
 * Offline gate check-in (ADR-035). All dependencies (Prisma, Tenancy, Audit,
 * Config) are global. Operational endpoints are gated by OFFLINE_CHECKIN_ENABLED
 * (off by default); the readiness endpoint always reports NO_GO when disabled.
 */
@Module({
  controllers: [OfflineCheckinController],
  providers: [
    OfflineManifestService,
    CheckInDeviceService,
    OfflineReconciliationService,
    OfflineCheckinReadinessService,
  ],
})
export class OfflineCheckinModule {}
