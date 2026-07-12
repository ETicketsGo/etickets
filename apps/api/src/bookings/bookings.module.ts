import { Module } from '@nestjs/common';
import { BookingsController, GuestBookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { PricingModule } from '../pricing/pricing.module';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [PricingModule, PaymentsModule],
  controllers: [BookingsController, GuestBookingsController],
  providers: [BookingsService],
  exports: [BookingsService],
})
export class BookingsModule {}
