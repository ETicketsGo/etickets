import { Module } from '@nestjs/common';
import { OpsController } from './ops.controller';
import { OpsService } from './ops.service';
import { MaintenanceService } from './maintenance.service';
import { holdsQueueProvider } from './holds-queue.provider';

/**
 * Internal operations console. Additive and admin-gated. PrismaModule/RedisModule
 * are @Global so they need no explicit import here. Exports MaintenanceService so
 * the global MaintenanceGuard (registered in AppModule) can resolve it.
 */
@Module({
  controllers: [OpsController],
  providers: [OpsService, MaintenanceService, holdsQueueProvider],
  exports: [OpsService, MaintenanceService],
})
export class OpsModule {}
