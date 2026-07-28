import { Module } from '@nestjs/common';
import { InventoryLockingModule } from '../../inventory/locking/inventory-locking.module';
import { PaymentsModule } from '../../payments/payments.module';
import { CompensationPlanner } from './compensation-planner';
import { CompensationRepository } from './compensation.repository';
import { CompensationService } from './compensation.service';
import { PaymentVoidExecutor } from './payment-void.executor';
import { CompensationAdminService } from './compensation-admin.service';
import { CompensationHealthService } from './compensation-health.service';
import {
  CompensationAdminController,
  CompensationHealthController,
} from './compensation-admin.controller';

/**
 * Booking compensation foundation (ADR-043, P5.3A). Provides the deterministic planner, the
 * durable idempotent repository, and the flag-gated planning/safe-execution service. All
 * behaviour is off by default; money-moving actions are never auto-executed in P5.3A.
 */
@Module({
  imports: [InventoryLockingModule, PaymentsModule],
  controllers: [CompensationAdminController, CompensationHealthController],
  providers: [
    CompensationPlanner,
    CompensationRepository,
    CompensationService,
    CompensationAdminService,
    CompensationHealthService,
    PaymentVoidExecutor,
  ],
  exports: [CompensationPlanner, CompensationRepository, CompensationService],
})
export class CompensationModule {}
