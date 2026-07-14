import { Module } from '@nestjs/common';
import { PaymentConfigService } from './payment-config.service';

/**
 * Runtime payment configuration (ADR-020). Exposes PaymentConfigService, which
 * reads env-scoped provider configs / routes / merchant accounts (PrismaModule is
 * global) and validates them fail-closed on boot. Consumed by the orchestrator
 * (M3) and the admin console (M5).
 */
@Module({
  providers: [PaymentConfigService],
  exports: [PaymentConfigService],
})
export class PaymentConfigModule {}
