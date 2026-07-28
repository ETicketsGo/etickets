import { Module } from '@nestjs/common';
import { InventoryLockingModule } from '../../inventory/locking/inventory-locking.module';
import { CompensationPlanner } from './compensation-planner';
import { CompensationRepository } from './compensation.repository';
import { CompensationService } from './compensation.service';

/**
 * Booking compensation foundation (ADR-043, P5.3A). Provides the deterministic planner, the
 * durable idempotent repository, and the flag-gated planning/safe-execution service. All
 * behaviour is off by default; money-moving actions are never auto-executed in P5.3A.
 */
@Module({
  imports: [InventoryLockingModule],
  providers: [CompensationPlanner, CompensationRepository, CompensationService],
  exports: [CompensationPlanner, CompensationRepository, CompensationService],
})
export class CompensationModule {}
