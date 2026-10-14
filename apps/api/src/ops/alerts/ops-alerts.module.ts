import { Global, Module } from '@nestjs/common';
import { OpsAlertService } from './ops-alert.service';

/**
 * Global so the payment, webhook, finance and notification paths can each take an optional
 * OpsAlertService without importing a module that knows about all of them. It depends only
 * on things that are already global: config, Redis, and the email transport exported by
 * NotificationsModule.
 */
@Global()
@Module({
  providers: [OpsAlertService],
  exports: [OpsAlertService],
})
export class OpsAlertsModule {}
