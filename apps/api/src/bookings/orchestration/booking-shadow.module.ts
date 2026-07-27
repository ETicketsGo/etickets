import { Module } from '@nestjs/common';
import { InventorySourcingModule } from '../../inventory/sourcing/inventory-sourcing.module';
import { BookingShadowObserver } from './booking-shadow-observer.service';

/**
 * Observer-only module for shadow booking orchestration (ADR-042). Deliberately depends
 * ONLY on the sourcing resolver (+ global config/metrics) so BookingsModule can import it
 * without a cycle (it does NOT depend on BookingsService/PaymentsService). This is what
 * lets BookingsService.create run shadow observation without importing the full
 * orchestrator.
 */
@Module({
  imports: [InventorySourcingModule],
  providers: [BookingShadowObserver],
  exports: [BookingShadowObserver],
})
export class BookingShadowModule {}
