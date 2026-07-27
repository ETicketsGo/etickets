import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../../metrics/metrics.service';
import { CircuitBreaker } from '../../payments/orchestration/circuit-breaker';
import { InventorySyncProviderRegistry } from './sync-provider.registry';
import { SyncCheckpointService } from './sync-checkpoint.service';
import { SyncIngestionService } from './sync-ingestion.service';

/**
 * Pull-based synchronization (ADR-040 §10). Reuses the existing CircuitBreaker (no new
 * resilience framework) and the PostgreSQL checkpoint lease (single-owner poll). A poll
 * acquires the lease, walks pages via the adapter's fetchChanges, DURABLY persists each
 * record (dedup + enqueue via the shared ingestion path), and advances the cursor ONLY
 * after every record in the batch is accepted — so a crash mid-poll never loses or
 * skips records. Bounded pages per run; circuit-open short-circuits outbound calls while
 * webhook ingestion keeps working independently.
 */
@Injectable()
export class SyncPollingService {
  private readonly logger = new Logger('SyncPolling');
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly maxPagesPerRun = 20;

  constructor(
    private readonly registry: InventorySyncProviderRegistry,
    private readonly checkpoints: SyncCheckpointService,
    private readonly ingestion: SyncIngestionService,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
  ) {}

  /** Poll every registered provider that supports polling (worker entry point). */
  async pollAll(): Promise<number> {
    if (!this.pollingEnabled) return 0;
    let total = 0;
    for (const p of this.registry.list()) {
      if (p.supportsPolling) total += await this.poll(p.providerCode);
    }
    return total;
  }

  private get pollingEnabled(): boolean {
    return (
      this.config.get<boolean>('INVENTORY_SYNC_ENABLED') === true &&
      this.config.get<boolean>('INVENTORY_SYNC_POLLING_ENABLED') === true
    );
  }

  private breaker(code: string): CircuitBreaker {
    let b = this.breakers.get(code);
    if (!b) {
      b = new CircuitBreaker({ failureThreshold: 5, cooldownMs: 60_000 });
      this.breakers.set(code, b);
    }
    return b;
  }

  /**
   * Poll one provider resource. Returns the number of records accepted this run. A
   * no-op when disabled, the provider can't poll, the lease is held elsewhere, or the
   * circuit is open.
   */
  async poll(providerCode: string, providerTenantId = '', resource = 'changes'): Promise<number> {
    if (!this.pollingEnabled) return 0;
    const provider = this.registry.get(providerCode);
    if (!provider || !provider.supportsPolling) return 0;

    const breaker = this.breaker(providerCode);
    if (!breaker.canAttempt()) {
      this.metrics.recordSyncPoll(providerCode, 'circuit_open');
      return 0;
    }

    const leaseSeconds = this.config.get<number>('INVENTORY_SYNC_POLL_INTERVAL_SECONDS', 300);
    const acquired = await this.checkpoints.acquireLease(
      providerCode,
      providerTenantId,
      resource,
      leaseSeconds,
    );
    if (!acquired) {
      this.metrics.recordSyncPoll(providerCode, 'skipped_lease');
      return 0;
    }

    let accepted = 0;
    const nextPollAt = new Date(Date.now() + leaseSeconds * 1000);
    try {
      const checkpoint = await this.checkpoints.get(providerCode, providerTenantId, resource);
      let cursor = checkpoint?.cursor ?? null;
      for (let page = 0; page < this.maxPagesPerRun; page++) {
        const batch = await provider.fetchChanges({ providerTenantId, cursor, pageSize: 100 });
        // Persist EVERY record before advancing the cursor (never advance early).
        for (const rec of batch.records) {
          const res = await this.ingestion.acceptEvent(providerCode, providerTenantId, {
            externalEventId: rec.externalEventId,
            eventType: rec.eventType,
            eventVersion: rec.eventVersion,
            externalEntityId: rec.externalEntityId,
            providerTenantId: rec.providerTenantId,
            providerOccurredAt: rec.providerOccurredAt,
            record: rec.record,
          });
          if (res.accepted) accepted += 1;
        }
        cursor = batch.nextCursor;
        await this.checkpoints.advance(
          providerCode,
          providerTenantId,
          resource,
          cursor,
          nextPollAt,
        );
        if (!batch.hasMore) break;
      }
      breaker.recordSuccess();
      this.metrics.recordSyncPoll(providerCode, 'ok');
      return accepted;
    } catch (err) {
      breaker.recordFailure();
      await this.checkpoints.recordFailure(providerCode, providerTenantId, resource, nextPollAt);
      this.metrics.recordSyncPoll(providerCode, 'error');
      this.logger.warn(
        `poll failed provider=${providerCode}: ${err instanceof Error ? err.name : 'unknown'}`,
      );
      return accepted;
    } finally {
      await this.checkpoints
        .releaseLease(providerCode, providerTenantId, resource)
        .catch(() => undefined);
    }
  }
}
