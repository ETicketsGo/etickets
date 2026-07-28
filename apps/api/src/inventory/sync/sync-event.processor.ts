import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from '../../metrics/metrics.service';
import {
  DOMAIN_EVENT_BUS,
  inventorySyncCompletedEvent,
  inventorySyncFailedEvent,
  type DomainEventBus,
} from '../../common/domain-events';
import { InventorySyncProviderRegistry } from './sync-provider.registry';
import { SyncApplicationService } from './sync-application.service';
import { classifySyncFailure } from './sync-failure.classifier';
import { ProviderSyncPermanentFailureError } from './sync.errors';
import type { InventoryOwnershipMode } from './contracts/canonical-change';

/**
 * Async worker for durable raw provider events (ADR-040 §9). Reloads the event from
 * PostgreSQL (jobs carry only ids), claims it atomically (so concurrent workers never
 * double-process), normalizes via the provider adapter, applies each canonical change
 * transactionally, and drives the terminal status by failure classification: retryable
 * failures retry with backoff up to max attempts (then DEAD_LETTERED); permanent /
 * security / mapping / version failures go straight to a terminal state — never an
 * endless loop. Idempotent: reprocessing an already-PROCESSED event is a no-op.
 */
@Injectable()
export class SyncEventProcessor {
  private readonly logger = new Logger('SyncProcessor');

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: InventorySyncProviderRegistry,
    private readonly application: SyncApplicationService,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
    @Inject(DOMAIN_EVENT_BUS) private readonly events: DomainEventBus,
  ) {}

  private get processingEnabled(): boolean {
    return (
      this.config.get<boolean>('INVENTORY_SYNC_ENABLED') === true &&
      this.config.get<boolean>('INVENTORY_SYNC_PROCESSING_ENABLED') === true
    );
  }

  async process(rawEventId: string): Promise<void> {
    if (!this.processingEnabled) return; // leaves the event QUEUED for later

    // Atomic claim: only a QUEUED / RETRYABLE_FAILURE event transitions to PROCESSING.
    const claim = await this.prisma.rawProviderEvent.updateMany({
      where: { id: rawEventId, processingStatus: { in: ['QUEUED', 'RETRYABLE_FAILURE'] } },
      data: { processingStatus: 'PROCESSING', attemptCount: { increment: 1 } },
    });
    if (claim.count !== 1) return; // already processed / claimed elsewhere

    const event = await this.prisma.rawProviderEvent.findUnique({ where: { id: rawEventId } });
    if (!event) return;

    const startedAt = Date.now();
    try {
      const provider = this.registry.get(event.providerCode);
      if (!provider) throw new ProviderSyncPermanentFailureError('provider not registered');

      const changes = await provider.normalize({
        externalEventId: event.externalEventId,
        eventType: event.eventType,
        eventVersion: event.eventVersion ?? undefined,
        externalEntityId: event.externalEntityId ?? undefined,
        providerTenantId: event.providerTenantId,
        providerOccurredAt: event.providerOccurredAt?.toISOString(),
        record: event.payloadJson,
      });

      let applied = 0;
      let ignored = 0;
      for (const change of changes) {
        const outcome = await this.application.apply(change, {
          providerCode: event.providerCode,
          providerTenantId: event.providerTenantId,
          defaultOwnershipMode: provider.ownershipMode as InventoryOwnershipMode,
          correlationId: event.correlationId ?? undefined,
        });
        outcome.applied ? (applied += 1) : (ignored += 1);
      }

      await this.prisma.rawProviderEvent.update({
        where: { id: rawEventId },
        data: {
          processingStatus: 'PROCESSED',
          processedAt: new Date(),
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
      this.metrics.recordSyncProcess(event.providerCode, 'processed');
      this.metrics.observeSyncProcessing((Date.now() - startedAt) / 1000);
      await this.publish(
        inventorySyncCompletedEvent(
          { providerCode: event.providerCode, rawEventId, applied, ignored },
          { correlationId: event.correlationId ?? undefined },
        ),
      );
    } catch (err) {
      await this.handleFailure(
        rawEventId,
        event.providerCode,
        event.attemptCount + 1,
        event.correlationId,
        err,
      );
    }
  }

  private async handleFailure(
    rawEventId: string,
    providerCode: string,
    attempt: number,
    correlationId: string | null,
    err: unknown,
  ): Promise<void> {
    const verdict = classifySyncFailure(err);
    const maxAttempts = this.config.get<number>('INVENTORY_SYNC_MAX_ATTEMPTS', 6);
    const code = (err as { code?: string })?.code ?? 'UNKNOWN';
    const message = err instanceof Error ? err.message : 'unknown error';

    let status = verdict.terminalStatus as string;
    if (verdict.retryable) {
      status = attempt >= maxAttempts ? 'DEAD_LETTERED' : 'RETRYABLE_FAILURE';
    }

    await this.prisma.rawProviderEvent.update({
      where: { id: rawEventId },
      data: {
        processingStatus: status as never,
        lastErrorCode: code,
        // Store the safe message only (never payloads/secrets).
        lastErrorMessage: message.slice(0, 500),
      },
    });
    this.metrics.recordSyncProcess(providerCode, `fail_${verdict.class.toLowerCase()}`);
    this.logger.warn(
      `sync event ${rawEventId} failed class=${verdict.class} status=${status} code=${code}`,
    );
    await this.publish(
      inventorySyncFailedEvent(
        { providerCode, rawEventId, reason: verdict.class },
        { correlationId: correlationId ?? undefined },
      ),
    );

    // Signal BullMQ to retry only when the verdict is retryable AND not dead-lettered.
    if (verdict.retryable && status === 'RETRYABLE_FAILURE') {
      throw err;
    }
  }

  /**
   * Sweep stuck RETRYABLE_FAILURE / QUEUED events (worker safety net alongside BullMQ
   * retries). Bounded; idempotent (each process() re-claims atomically).
   */
  async sweep(limit = 50): Promise<number> {
    if (!this.processingEnabled) return 0;
    const stuck = await this.prisma.rawProviderEvent.findMany({
      where: { processingStatus: { in: ['QUEUED', 'RETRYABLE_FAILURE'] } },
      orderBy: { receivedAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    for (const e of stuck) await this.process(e.id);
    return stuck.length;
  }

  private async publish(event: Parameters<DomainEventBus['publish']>[0]): Promise<void> {
    try {
      await this.events.publish(event);
    } catch {
      /* event publication is best-effort; the DB status is authoritative */
    }
  }
}
