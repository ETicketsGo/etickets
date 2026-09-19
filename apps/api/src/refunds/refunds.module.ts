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
  // Exported for the guest access-link entry (`requestAsGuest`), which lives on
  // GuestBookingService so that guest authorisation stays in one place — while the refund RULES
  // stay in exactly one place too, here. The dependency runs one way: booking orchestration
  // imports refunds, and refunds knows nothing about bookings.
  exports: [RefundsService],
})
export class RefundsModule {}
