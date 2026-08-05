import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InventorySyncProviderRegistry } from './sync-provider.registry';
import { SyncIngestionService } from './sync-ingestion.service';
import { SyncEventProcessor } from './sync-event.processor';
import { SyncApplicationService } from './sync-application.service';
import { SyncCheckpointService } from './sync-checkpoint.service';
import { SyncPollingService } from './sync-polling.service';
import { SyncReconciliationService } from './sync-reconciliation.service';
import { ProviderSyncHealthService } from './sync-health.service';
import { SyncOpsService } from './sync-ops.service';
import { ManualInventorySyncProvider } from './providers/manual-sync.provider';
import { MockAggregatorInventorySyncProvider } from './providers/mock-aggregator-sync.provider';
import { SyncWebhookController } from './sync-webhook.controller';
import { SyncOpsController } from './sync-ops.controller';
import { inventorySyncQueueProvider } from './sync-queue.provider';

/**
 * External inventory synchronization platform (ADR-040). Depends only on @Global
 * modules (Prisma, Redis, Metrics, Cache, Secrets, Audit, P2 DomainEvents) — no cycles.
 * Registers the Manual reference adapter always, and the dev/test-only Mock aggregator
 * ONLY when INVENTORY_SYNC_MOCK_PROVIDER_ENABLED. Importing the module changes no
 * behaviour: every path is gated by INVENTORY_SYNC_* flags (all off by default) and the
 * webhook route fails closed when disabled.
 */
@Module({
  controllers: [SyncWebhookController, SyncOpsController],
  providers: [
    inventorySyncQueueProvider,
    InventorySyncProviderRegistry,
    SyncIngestionService,
    SyncApplicationService,
    SyncEventProcessor,
    SyncCheckpointService,
    SyncPollingService,
    SyncReconciliationService,
    ProviderSyncHealthService,
    SyncOpsService,
    ManualInventorySyncProvider,
    MockAggregatorInventorySyncProvider,
  ],
  exports: [
    SyncEventProcessor,
    SyncPollingService,
    SyncReconciliationService,
    ProviderSyncHealthService,
    InventorySyncProviderRegistry,
  ],
})
export class InventorySyncModule implements OnModuleInit {
  constructor(
    private readonly registry: InventorySyncProviderRegistry,
    private readonly config: ConfigService,
    private readonly manual: ManualInventorySyncProvider,
    private readonly mock: MockAggregatorInventorySyncProvider,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.manual);
    if (this.config.get<boolean>('INVENTORY_SYNC_MOCK_PROVIDER_ENABLED')) {
      this.registry.register(this.mock);
    }
  }
}
