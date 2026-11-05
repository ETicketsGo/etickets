import { Global, Module } from '@nestjs/common';
import { HumanCheckRisk } from './human-check-risk';
import { HumanCheckGuard } from './human-check.guard';
import { HumanCheckService } from './human-check.service';

/**
 * Global so `@RequiresHumanCheck` works on any controller without each module importing this
 * one: a route guard is built in the controller's own module, and its dependencies must be
 * visible there.
 */
@Global()
@Module({
  providers: [HumanCheckRisk, HumanCheckService, HumanCheckGuard],
  exports: [HumanCheckRisk, HumanCheckService, HumanCheckGuard],
})
export class HumanCheckModule {}
