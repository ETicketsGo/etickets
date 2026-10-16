import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module';
import { PaymentsModule } from '../payments/payments.module';
import { CounterSalesController } from './counter-sales.controller';
import { CounterSalesService } from './counter-sales.service';

/** Selling at the box office: the booking path, then the counter's cash collection. */
@Module({
  imports: [BookingsModule, PaymentsModule],
  controllers: [CounterSalesController],
  providers: [CounterSalesService],
})
export class CounterModule {}
