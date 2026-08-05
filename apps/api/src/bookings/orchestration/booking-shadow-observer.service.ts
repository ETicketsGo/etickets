import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ExperienceType } from '@eticketsgo/shared-types';
import { MetricsService } from '../../metrics/metrics.service';
import { InventoryResolver } from '../../inventory/sourcing/inventory.resolver';

export interface BookingShadowContext {
  bookingId: string;
  eventSessionId: string;
  experienceType: ExperienceType;
  seatCount: number;
  quantity: number;
}

/** Shadow mismatch categories (ADR-042 §6). Bounded metric-label vocabulary. */
export type ShadowMismatch =
  | 'PROVIDER_SELECTION_MISMATCH'
  | 'INVENTORY_DECISION_MISMATCH'
  | 'LOCK_RESULT_MISMATCH'
  | 'PAYMENT_PROVIDER_MISMATCH'
  | 'WORKFLOW_STATE_MISMATCH'
  | 'TIMEOUT_POLICY_MISMATCH';

/**
 * Orchestration SHADOW observer (ADR-042 §6). Runs AFTER the legacy booking hold has
 * already succeeded and only OBSERVES what the orchestrator would decide — it creates no
 * booking/hold/payment/ticket, publishes no production events, and never fails the legacy
 * request. It records the provider the orchestrator would select and the expected
 * workflow state, classifying any divergence. Lock observation is already covered by the
 * P3 seat-lock shadow (this does not re-acquire a lock). No-op unless
 * BOOKING_ORCHESTRATOR_ENABLED and MODE=shadow.
 */
@Injectable()
export class BookingShadowObserver {
  private readonly logger = new Logger('BookingShadow');

  constructor(
    private readonly resolver: InventoryResolver,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
  ) {}

  private get active(): boolean {
    return (
      this.config.get<boolean>('BOOKING_ORCHESTRATOR_ENABLED') === true &&
      this.config.get<string>('BOOKING_ORCHESTRATOR_MODE', 'shadow') === 'shadow'
    );
  }

  async observe(ctx: BookingShadowContext): Promise<void> {
    if (!this.active) return;
    try {
      const provider = await this.resolver.resolve({
        experienceType: ctx.experienceType,
        eventSessionId: ctx.eventSessionId,
      });
      // The legacy path is always LOCAL-authoritative; the orchestrator selecting a
      // non-LOCAL provider for the same booking is a divergence worth measuring.
      if (provider.capabilities.authority !== 'LOCAL') {
        this.record('PROVIDER_SELECTION_MISMATCH');
        return;
      }
      // Consistent: legacy held → orchestrator would be LOCKED with a LOCAL provider.
      this.metrics.recordBookingShadow('observed_ok', provider.name);
    } catch {
      // Provider resolution itself failing while the legacy hold succeeded is a divergence.
      this.record('INVENTORY_DECISION_MISMATCH');
    }
  }

  private record(mismatch: ShadowMismatch): void {
    this.metrics.recordBookingShadowMismatch(mismatch);
    this.logger.warn(`shadow booking divergence: ${mismatch}`);
  }
}
