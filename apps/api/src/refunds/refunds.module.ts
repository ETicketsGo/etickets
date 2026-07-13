import { Module } from '@nestjs/common';
import { AdminRefundsController, RefundsController } from './refunds.controller';
import { RefundsService } from './refunds.service';
import { PaymentsModule } from '../payments/payments.module';
import { InventoryModule } from '../inventory/inventory.module';

@Module({
  imports: [PaymentsModule, InventoryModule],
  controllers: [RefundsController, AdminRefundsController],
  providers: [RefundsService],
})
export class RefundsModule {}
