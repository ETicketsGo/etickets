import { Module } from '@nestjs/common';
import { AdminRefundsController, RefundsController } from './refunds.controller';
import { RefundsService } from './refunds.service';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [PaymentsModule],
  controllers: [RefundsController, AdminRefundsController],
  providers: [RefundsService],
})
export class RefundsModule {}
