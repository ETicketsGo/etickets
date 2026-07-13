import { Module } from '@nestjs/common';
import { ExperienceModule } from '../experience/experience.module';
import { GeneralAdmissionInventoryStrategy } from './general-admission.strategy';
import { SeatBasedInventoryStrategy } from './seat-based.strategy';
import { InventoryService } from './inventory.service';

/**
 * Owns the pluggable inventory strategies and resolves them per experience type.
 * Booking/payment modules import this to reserve/confirm/release stock without
 * knowing which inventory model is in play. See ADR-010.
 */
@Module({
  imports: [ExperienceModule],
  providers: [GeneralAdmissionInventoryStrategy, SeatBasedInventoryStrategy, InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
