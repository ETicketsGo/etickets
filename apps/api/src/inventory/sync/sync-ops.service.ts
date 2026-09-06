import { HttpStatus, Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { AppException, ErrorCodes } from '../../common/errors';
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
export class SyncOpsService implements OnModuleDestroy {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly reconciliation: SyncReconciliationService,
    private readonly health: ProviderSyncHealthService,
    private readonly checkpoints: SyncCheckpointService,
    @Inject(INVENTORY_SYNC_QUEUE) private readonly queue: Queue<InventorySyncJob>,
  ) {}

  /**
   * Close the sync queue's Redis connection on shutdown, mirroring what OpsService does for
   * the `holds` queue.
   *
   * `inventorySyncQueueProvider` builds this Queue with a `useFactory`, and Nest does not
   * tear down factory-produced objects — so nothing was closing it. An open BullMQ Queue
   * keeps an ioredis socket alive, and an open socket keeps the Node event loop alive, so
   * the API process would not exit after `app.close()` even once shutdown hooks were
   * enabled: SIGTERM was acknowledged, teardown ran, and then the process simply hung until
   * the platform's grace period expired and it was SIGKILLed (observed as exit 137 after the
   * full timeout on every deploy and restart). Closing it here is what actually lets the
   * process exit.
   */
  async onModuleDestroy(): Promise<void> {
    // try/catch, not just .catch(): a synchronous throw here would abort Nest's shutdown
    // chain before the remaining teardown hooks run — reinstating the very hang this
    // method exists to prevent. Teardown must never be the thing that blocks teardown.
    try {
      await this.queue.close();
    } catch {
      /* best-effort: a Redis already gone at shutdown must not delay exit */
    }
  }

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

  /**
   * The operator review queue: external records this provider has published that nobody has
   * linked to anything yet.
   *
   * This is the production catalogue path. Sync ingests, records identity, and stops here on
   * purpose — a vendor feed that could create and publish internal entities could also rename
   * a storefront or unpublish a screening somebody holds a ticket for. Someone has to look.
   *
   * Bounded, and metadata only: no raw provider payloads, no secrets.
   */
  async listMappings(params: {
    providerCode?: string;
    status?: string;
    externalEntityType?: string;
    limit?: number;
  }) {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
    return this.prisma.providerMapping.findMany({
      where: {
        providerCode: params.providerCode,
        // Defaults to what needs a decision, not to everything: the queue is the point.
        status: (params.status ?? 'UNMAPPED') as never,
        externalEntityType: params.externalEntityType,
      },
      select: {
        id: true,
        providerCode: true,
        providerTenantId: true,
        externalEntityType: true,
        externalEntityId: true,
        externalVersion: true,
        internalEntityType: true,
        internalEntityId: true,
        ownershipMode: true,
        status: true,
        lastSyncedAt: true,
      },
      orderBy: [{ externalEntityType: 'asc' }, { externalEntityId: 'asc' }],
      take: limit,
    });
  }

  /**
   * Internal entity types an operator may link a provider record to, and how to check one
   * exists.
   *
   * An allowlist rather than a dynamic delegate lookup: `internalEntityType` is a free-text
   * column, and turning arbitrary caller input into a Prisma model name is how a typo becomes
   * an exception and a clever string becomes something worse.
   */
  private static readonly LINKABLE = [
    'cinema',
    'screen',
    'movie',
    'event',
    'eventSession',
    'seat',
    'seatCategory',
    'venue',
  ] as const;

  /**
   * Resolve an unmapped/ambiguous mapping to a specific internal entity (never guessed).
   *
   * The link is VERIFIED before it is written. An ACTIVE mapping is what the booking path
   * trusts to decide a session is provider-authoritative and what inventory ref to reserve
   * against, so a mapping pointing at an id that does not exist is worse than no mapping at
   * all: it looks approved and fails at the moment a customer is trying to pay.
   */
  async resolveMapping(
    actorUserId: string | null,
    mappingId: string,
    internalEntityType: string,
    internalEntityId: string,
  ): Promise<void> {
    if (!(SyncOpsService.LINKABLE as readonly string[]).includes(internalEntityType)) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        `'${internalEntityType}' is not an entity a provider record can be linked to.`,
        HttpStatus.BAD_REQUEST,
        { linkable: SyncOpsService.LINKABLE },
      );
    }
    const exists = await this.internalEntityExists(internalEntityType, internalEntityId);
    if (!exists) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        `No ${internalEntityType} with that id exists, so the provider record cannot be linked to it.`,
        HttpStatus.NOT_FOUND,
        { internalEntityType },
      );
    }
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

  private async internalEntityExists(type: string, id: string): Promise<boolean> {
    const where = { where: { id }, select: { id: true } } as never;
    switch (type) {
      case 'cinema':
        return Boolean(await this.prisma.cinema.findUnique(where));
      case 'screen':
        return Boolean(await this.prisma.screen.findUnique(where));
      case 'movie':
        return Boolean(await this.prisma.movie.findUnique(where));
      case 'event':
        return Boolean(await this.prisma.event.findUnique(where));
      case 'eventSession':
        return Boolean(await this.prisma.eventSession.findUnique(where));
      case 'seat':
        return Boolean(await this.prisma.seat.findUnique(where));
      case 'seatCategory':
        return Boolean(await this.prisma.seatCategory.findUnique(where));
      case 'venue':
        return Boolean(await this.prisma.venue.findUnique(where));
      default:
        return false;
    }
  }

  runReconciliation(providerCode?: string, limit?: number) {
    return this.reconciliation.reconcile({ providerCode, limit });
  }

  providerHealth(providerCode: string) {
    return this.health.report(providerCode);
  }
}
