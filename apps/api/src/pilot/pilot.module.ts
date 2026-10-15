import { Global, Module } from '@nestjs/common';
import { PilotGuardService } from './pilot-guard.service';
import { PilotAutoPauseService } from './pilot-auto-pause.service';

/**
 * The controlled India pilot: sale limits and the automatic pause. See pilot-config.ts and
 * docs/go-live/PILOT-GUARD.md.
 *
 * Global for the reason OpsAlertsModule is: bookings, payments and ops each take an optional
 * PilotGuardService, and it depends only on things that are already global (Prisma, config,
 * audit, Redis, ops alerts). Part of AppModule, so the worker - which boots AppModule and runs
 * the webhook processor and the reconciliation - pauses on the same alerts the API does.
 */
@Global()
@Module({
  providers: [PilotGuardService, PilotAutoPauseService],
  exports: [PilotGuardService, PilotAutoPauseService],
})
export class PilotModule {}
