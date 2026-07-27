import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { INVENTORY_SYNC_QUEUE, type InventorySyncJob } from './sync-queue.provider';
import { SyncReconciliationService } from './sync-reconciliation.service';
import { ProviderSyncHealthService } from './sync-health.service';
import { SyncCheckpointService } from './sync-checkpoint.service';
import { ProviderPayloadInvalidError } from './sync.errors';
import type { Queue } from 'bullmq';

/**
 * Internal/admin operations for the sync platform (ADR-040 §22). Every mutating action
 * is AUDITED (actor + action + safe metadata). No raw secrets or unrestricted provider
 * payloads are ever returned. RBAC is enforced at the controller (ADMIN only).
 */
@Injectable()
export class SyncOpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly reconciliation: SyncReconciliationService,
    private readonly health: ProviderSyncHealthService,
    private readonly checkpoints: SyncCheckpointService,
    @Inject(INVENTORY_SYNC_QUEUE) private readonly queue: Queue<InventorySyncJob>,
  ) {}

  /** Requeue a raw event for reprocessing (idempotent — the worker re-claims atomically). */
  async reprocess(actorUserId: string | null, rawEventId: string): Promise<{ requeued: boolean }> {
    const event = await this.prisma.rawProviderEvent.findUnique({
      where: { id: rawEventId },
      select: { providerCode: true },
    });
    if (!event) throw new ProviderPayloadInvalidError('event not found');
    await this.prisma.rawProviderEvent.update({
      where: { id: rawEventId },
      data: { processingStatus: 'QUEUED' },
    });
    await this.queue.add(
      'process',
      { rawEventId, providerCode: event.providerCode },
      { jobId: `reprocess-${rawEventId}-${Date.now()}` },
    );
    await this.audit.record({
      actorUserId,
      action: 'SYNC_EVENT_REPROCESS',
      entityType: 'RawProviderEvent',
      entityId: rawEventId,
    });
    return { requeued: true };
  }

  async markManualReview(actorUserId: string | null, rawEventId: string): Promise<void> {
    await this.prisma.rawProviderEvent.update({
      where: { id: rawEventId },
      data: { processingStatus: 'MANUAL_REVIEW' },
    });
    await this.audit.record({
      actorUserId,
      action: 'SYNC_EVENT_MANUAL_REVIEW',
      entityType: 'RawProviderEvent',
      entityId: rawEventId,
    });
  }

  /** Requeue bounded failed events for a provider. */
  async retryFailed(
    actorUserId: string | null,
    providerCode: string,
    limit = 50,
  ): Promise<{ requeued: number }> {
    const events = await this.prisma.rawProviderEvent.findMany({
      where: { providerCode, processingStatus: { in: ['RETRYABLE_FAILURE', 'DEAD_LETTERED'] } },
      take: Math.min(limit, 500),
      select: { id: true },
    });
    for (const e of events) {
      await this.prisma.rawProviderEvent.update({
        where: { id: e.id },
        data: { processingStatus: 'QUEUED' },
      });
      await this.queue.add(
        'process',
        { rawEventId: e.id, providerCode },
        { jobId: `retry-${e.id}-${Date.now()}` },
      );
    }
    await this.audit.record({
      actorUserId,
      action: 'SYNC_RETRY_FAILED',
      entityType: 'InventorySync',
      entityId: providerCode,
      metadata: { count: events.length },
    });
    return { requeued: events.length };
  }

  async resetCheckpoint(
    actorUserId: string | null,
    providerCode: string,
    providerTenantId: string,
    resource: string,
  ): Promise<void> {
    await this.checkpoints.advance(providerCode, providerTenantId, resource, null, new Date());
    await this.audit.record({
      actorUserId,
      action: 'SYNC_CHECKPOINT_RESET',
      entityType: 'ProviderSyncCheckpoint',
      entityId: `${providerCode}:${resource}`,
    });
  }

  async inspectMapping(
    providerCode: string,
    externalEntityType: string,
    externalEntityId: string,
    providerTenantId = '',
  ) {
    // Returns mapping metadata only — never secrets/raw payloads.
    return this.prisma.providerMapping.findUnique({
      where: {
        providerCode_providerTenantId_externalEntityType_externalEntityId: {
          providerCode,
          providerTenantId,
          externalEntityType,
          externalEntityId,
        },
      },
      select: {
        id: true,
        status: true,
        internalEntityType: true,
        internalEntityId: true,
        externalVersion: true,
        ownershipMode: true,
        lastSyncedAt: true,
      },
    });
  }

  /** Resolve an ambiguous/unmapped mapping to a specific internal entity (never guessed). */
  async resolveMapping(
    actorUserId: string | null,
    mappingId: string,
    internalEntityType: string,
    internalEntityId: string,
  ): Promise<void> {
    await this.prisma.providerMapping.update({
      where: { id: mappingId },
      data: { internalEntityType, internalEntityId, status: 'ACTIVE' },
    });
    await this.audit.record({
      actorUserId,
      action: 'SYNC_MAPPING_RESOLVE',
      entityType: 'ProviderMapping',
      entityId: mappingId,
      metadata: { internalEntityType },
    });
  }

  runReconciliation(providerCode?: string, limit?: number) {
    return this.reconciliation.reconcile({ providerCode, limit });
  }

  providerHealth(providerCode: string) {
    return this.health.report(providerCode);
  }
}
