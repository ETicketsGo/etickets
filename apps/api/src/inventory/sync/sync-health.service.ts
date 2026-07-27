import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from '../../metrics/metrics.service';
import {
  DOMAIN_EVENT_BUS,
  providerHealthChangedEvent,
  type DomainEventBus,
} from '../../common/domain-events';
import { InventorySyncProviderRegistry } from './sync-provider.registry';
import type { ProviderSyncHealthState } from './contracts/sync-provider.interface';

export interface ProviderSyncHealthReport {
  providerCode: string;
  state: ProviderSyncHealthState;
  queueBacklog: number;
  deadLettered: number;
  manualReview: number;
  oldestUnprocessedAt: string | null;
  reason?: string;
}

/**
 * Provider sync health (ADR-040 §20) derived from durable signals: queue backlog,
 * dead-letters, manual-review count, oldest unprocessed event, plus the adapter's own
 * health. Emits ProviderHealthChanged (P2 bus) on a state transition and records the
 * state metric. Health informs routing only through explicit priority/capability rules
 * — it never auto-fails provider-authoritative inventory over to local stock.
 */
@Injectable()
export class ProviderSyncHealthService {
  private readonly last = new Map<string, ProviderSyncHealthState>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: InventorySyncProviderRegistry,
    private readonly metrics: MetricsService,
    @Inject(DOMAIN_EVENT_BUS) private readonly events: DomainEventBus,
  ) {}

  async report(providerCode: string): Promise<ProviderSyncHealthReport> {
    const provider = this.registry.get(providerCode);
    const [queueBacklog, deadLettered, manualReview, oldest] = await Promise.all([
      this.prisma.rawProviderEvent.count({
        where: { providerCode, processingStatus: { in: ['QUEUED', 'RETRYABLE_FAILURE'] } },
      }),
      this.prisma.rawProviderEvent.count({
        where: { providerCode, processingStatus: 'DEAD_LETTERED' },
      }),
      this.prisma.rawProviderEvent.count({
        where: { providerCode, processingStatus: 'MANUAL_REVIEW' },
      }),
      this.prisma.rawProviderEvent.findFirst({
        where: { providerCode, processingStatus: { in: ['QUEUED', 'RETRYABLE_FAILURE'] } },
        orderBy: { receivedAt: 'asc' },
        select: { receivedAt: true },
      }),
    ]);

    const adapterHealth = provider
      ? await provider.health().catch(() => ({ state: 'UNKNOWN' as const }))
      : { state: 'DISABLED' as const };
    const state = this.derive(adapterHealth.state, queueBacklog, deadLettered);

    // Emit ProviderHealthChanged only on a transition.
    const previous = this.last.get(providerCode);
    if (previous !== state) {
      this.last.set(providerCode, state);
      this.metrics.recordProviderHealth(providerCode, state);
      await this.events
        .publish(providerHealthChangedEvent({ providerCode, state, previous }))
        .catch(() => undefined);
    }

    return {
      providerCode,
      state,
      queueBacklog,
      deadLettered,
      manualReview,
      oldestUnprocessedAt: oldest?.receivedAt.toISOString() ?? null,
    };
  }

  private derive(
    adapterState: ProviderSyncHealthState,
    backlog: number,
    deadLettered: number,
  ): ProviderSyncHealthState {
    if (adapterState === 'DISABLED') return 'DISABLED';
    if (adapterState === 'UNHEALTHY' || deadLettered > 0) return 'UNHEALTHY';
    if (adapterState === 'DEGRADED' || backlog > 1000) return 'DEGRADED';
    if (adapterState === 'UNKNOWN') return 'UNKNOWN';
    return 'HEALTHY';
  }
}
