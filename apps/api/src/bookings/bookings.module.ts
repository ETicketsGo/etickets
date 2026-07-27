import { Module } from '@nestjs/common';
import { BookingsController, GuestBookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { PricingModule } from '../pricing/pricing.module';
import { PaymentsModule } from '../payments/payments.module';
import { InventoryModule } from '../inventory/inventory.module';
import { CommerceModule } from '../commerce/commerce.module';
import { InventoryLockingModule } from '../inventory/locking/inventory-locking.module';
import { BookingShadowModule } from './orchestration/booking-shadow.module';

@Module({
  imports: [
    PricingModule,
    PaymentsModule,
    InventoryModule,
    CommerceModule,
    InventoryLockingModule,
    BookingShadowModule,
  ],
  controllers: [BookingsController, GuestBookingsController],
  providers: [BookingsService],
  exports: [BookingsService],
})
export class BookingsModule {}
