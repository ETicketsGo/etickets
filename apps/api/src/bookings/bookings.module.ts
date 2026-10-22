import { Module } from '@nestjs/common';
import { BookingsService } from './bookings.service';
import { BookingHoldLimitsService } from './booking-hold-limits';
import { PricingModule } from '../pricing/pricing.module';
import { PaymentsModule } from '../payments/payments.module';
import { InventoryModule } from '../inventory/inventory.module';
import { CommerceModule } from '../commerce/commerce.module';
import { InventoryLockingModule } from '../inventory/locking/inventory-locking.module';
import { BookingShadowModule } from './orchestration/booking-shadow.module';

// NOTE: the booking HTTP controllers live in BookingOrchestrationModule (P5.2A) so they can
// route through the single BookingExecutionRouter without a DI cycle. BookingsModule owns
// only the legacy BookingsService domain logic, which the orchestrator/router compose.
@Module({
  imports: [
    PricingModule,
    PaymentsModule,
    InventoryModule,
    CommerceModule,
    InventoryLockingModule,
    BookingShadowModule,
  ],
  // BookingHoldLimitsService is optional in BookingsService's constructor only for hand-built
  // test harnesses; providing it here is what makes the active-hold limits real.
  providers: [BookingsService, BookingHoldLimitsService],
  exports: [BookingsService],
})
export class BookingsModule {}
