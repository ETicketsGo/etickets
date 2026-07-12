import { Module } from '@nestjs/common';
import { AdminPayoutsController, PayoutsController } from './payouts.controller';
import { PayoutsService } from './payouts.service';

@Module({
  controllers: [PayoutsController, AdminPayoutsController],
  providers: [PayoutsService],
})
export class PayoutsModule {}
