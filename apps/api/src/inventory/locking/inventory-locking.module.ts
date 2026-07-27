import { Module } from '@nestjs/common';
import { RedisLockStore } from './redis-lock.store';
import { InventoryLockService } from './inventory-lock.service';
import { InventoryLockReconciliationService } from './inventory-lock-reconciliation.service';
import { InventoryLockConfirmationService } from './inventory-lock-confirmation.service';
import { InventoryLockShadowService } from './inventory-lock-shadow.service';
import { InventoryLockHealthService } from './inventory-lock.health';
import { INVENTORY_LOCK_SERVICE } from './inventory-lock.types';

/**
 * Distributed Redis seat-lock engine (ADR-039). Reuses the shared @Global RedisService
 * (no new client, no Redlock) and the P2 DomainEventBus (@Global). Depends on nothing
 * that depends back on it (no cycles). Exports the provider-neutral lock service (via
 * the INVENTORY_LOCK_SERVICE token and the class), the confirmation seam, the shadow
 * observer, reconciliation and health. Importing it changes no behaviour while
 * INVENTORY_LOCKS_ENABLED is off.
 */
@Module({
  providers: [
    RedisLockStore,
    InventoryLockReconciliationService,
    InventoryLockService,
    InventoryLockConfirmationService,
    InventoryLockShadowService,
    InventoryLockHealthService,
    { provide: INVENTORY_LOCK_SERVICE, useExisting: InventoryLockService },
  ],
  exports: [
    INVENTORY_LOCK_SERVICE,
    InventoryLockService,
    InventoryLockConfirmationService,
    InventoryLockShadowService,
    InventoryLockReconciliationService,
    InventoryLockHealthService,
  ],
})
export class InventoryLockingModule {}
