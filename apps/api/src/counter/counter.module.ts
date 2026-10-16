import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module';
import { PaymentsModule } from '../payments/payments.module';
import { RefundsModule } from '../refunds/refunds.module';
import { CashReturnsController } from './cash-returns.controller';
import { CounterSalesController } from './counter-sales.controller';
import { CounterSalesService } from './counter-sales.service';

/**
 * Selling at the box office: the booking path, then the counter's cash collection. And the
 * cash handed back when a show is cancelled (the service lives with the cancellation refunds).
 */
@Module({
  imports: [BookingsModule, PaymentsModule, RefundsModule],
  controllers: [CounterSalesController, CashReturnsController],
  providers: [CounterSalesService],
})
export class CounterModule {}
