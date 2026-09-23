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

@Module({
  controllers: [PayoutsController, AdminPayoutsController, AdminPayoutSettingsController],
  providers: [PayoutsService, PayoutSettingsService, PayoutAccountsService, PayoutRunService],
  // PayoutRunService is exported for the worker, which runs settlements on a schedule.
  exports: [PayoutsService, PayoutSettingsService, PayoutAccountsService, PayoutRunService],
})
export class PayoutsModule {}
