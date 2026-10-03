import { Module } from '@nestjs/common';
import {
  AdminPayoutSettingsController,
  AdminPayoutsController,
  PayoutsController,
} from './payouts.controller';
import { PayoutsService } from './payouts.service';
import { PayoutSettingsService } from './payout-settings.service';
import { PayoutAccountsService } from './payout-accounts.service';
import { PayoutRunService } from './payout-run.service';
import { UnifiedFinanceService } from '../finance/unified-finance.service';

@Module({
  controllers: [PayoutsController, AdminPayoutsController, AdminPayoutSettingsController],
  /*
    UnifiedFinanceService lives here rather than in its own module: it answers the same
    organizer-facing question as the payout summary, from the same tenancy boundary, and a module
    whose only member is one read-only service adds a graph node without adding a boundary.
  */
  providers: [
    PayoutsService,
    PayoutSettingsService,
    PayoutAccountsService,
    PayoutRunService,
    UnifiedFinanceService,
  ],
  // PayoutRunService is exported for the worker, which runs settlements on a schedule.
  exports: [
    PayoutsService,
    PayoutSettingsService,
    PayoutAccountsService,
    PayoutRunService,
    UnifiedFinanceService,
  ],
})
export class PayoutsModule {}
