import { Module } from '@nestjs/common';
import {
  AdminPayoutSettingsController,
  AdminPayoutsController,
  PayoutsController,
} from './payouts.controller';
import { PayoutsService } from './payouts.service';
import { PayoutSettingsService } from './payout-settings.service';

@Module({
  controllers: [PayoutsController, AdminPayoutsController, AdminPayoutSettingsController],
  providers: [PayoutsService, PayoutSettingsService],
  exports: [PayoutsService, PayoutSettingsService],
})
export class PayoutsModule {}
