import { Module } from '@nestjs/common';
import {
  AdminRefundsController,
  OrganizationRefundsController,
  RefundsController,
} from './refunds.controller';
import { RefundsService } from './refunds.service';
import { PaymentsModule } from '../payments/payments.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ReceiptsModule } from '../receipts/receipts.module';

@Module({
  imports: [PaymentsModule, InventoryModule, ReceiptsModule],
  controllers: [RefundsController, OrganizationRefundsController, AdminRefundsController],
  providers: [RefundsService],
})
export class RefundsModule {}
