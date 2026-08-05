import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, ErrorCodes } from '../../../common/errors';
import type {
  AvailabilityQuery,
  AvailabilitySnapshot,
  ConfirmResult,
  InventoryProvider,
  InventoryProviderCapabilities,
  InventorySourceKind,
  InventoryWriteContext,
  LockRequest,
  LockResult,
  ProviderHealth,
  RefundInventoryRequest,
  SearchQuery,
  SearchResultItem,
  SyncRequest,
  SyncResult,
} from '../inventory-provider.interface';

/**
 * PLACEHOLDER adapter for a future external aggregator / third-party theatre API.
 *
 * It exists so the platform can be wired for external inventory today WITHOUT
 * hard-coding any vendor and without changing the booking engine when a real
 * integration lands: a concrete vendor adapter will extend this shape behind the
 * `INVENTORY_AGGREGATOR_ENABLED` flag.
 *
 * Until then every operation FAILS CLOSED with a clear error — it never fabricates
 * availability, locks or confirmations. `health()` reports unhealthy/unconfigured so
 * the ProviderHealthMonitor keeps it out of any candidate set. See ADR-037.
 */
@Injectable()
export class AggregatorInventoryProvider implements InventoryProvider {
  readonly name = 'aggregator';
  readonly sourceKind: InventorySourceKind = 'AGGREGATOR';

  // Declares what a real aggregator WOULD do (serve remote search, be reconciled via
  // sync, and be eligible for failover) so routing/priority code is exercised even
  // while the concrete integration is pending.
  readonly capabilities: InventoryProviderCapabilities = {
    search: true,
    authority: 'REMOTE',
    failover: true,
  };

  private notIntegrated(op: string): never {
    throw new AppException(
      ErrorCodes.INVENTORY_PROVIDER_UNAVAILABLE,
      `Aggregator inventory is not integrated yet (${op}). Enable a concrete vendor adapter behind INVENTORY_AGGREGATOR_ENABLED.`,
      HttpStatus.NOT_IMPLEMENTED,
      { provider: this.name, op },
    );
  }

  async search(_query: SearchQuery): Promise<SearchResultItem[]> {
    void _query;
    return this.notIntegrated('search');
  }

  async availability(_query: AvailabilityQuery): Promise<AvailabilitySnapshot> {
    void _query;
    return this.notIntegrated('availability');
  }

  async lockInventory(_req: LockRequest): Promise<LockResult> {
    void _req;
    return this.notIntegrated('lockInventory');
  }

  async confirmBooking(_ctx: InventoryWriteContext): Promise<ConfirmResult> {
    void _ctx;
    return this.notIntegrated('confirmBooking');
  }

  async cancelBooking(_ctx: InventoryWriteContext): Promise<void> {
    void _ctx;
    return this.notIntegrated('cancelBooking');
  }

  async refund(_req: RefundInventoryRequest): Promise<void> {
    void _req;
    return this.notIntegrated('refund');
  }

  async sync(_req: SyncRequest): Promise<SyncResult> {
    void _req;
    return this.notIntegrated('sync');
  }

  /** Never healthy while unintegrated — keeps the resolver from ever selecting it. */
  async health(): Promise<ProviderHealth> {
    return { healthy: false, reason: 'not_integrated', checkedAt: new Date() };
  }
}
