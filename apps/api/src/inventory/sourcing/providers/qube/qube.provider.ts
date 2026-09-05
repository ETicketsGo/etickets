import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, ErrorCodes } from '../../../../common/errors';
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
} from '../../inventory-provider.interface';

/**
 * The real Qube Cinema adapter. Deliberately empty.
 *
 * ── WHY THERE IS NO IMPLEMENTATION HERE ────────────────────────────────────────────
 * We have no Qube API documentation, no credentials, no sandbox, and no confirmation of what
 * ticketing APIs Qube exposes. Writing plausible-looking endpoints and payloads would produce
 * a file that reads like an integration and is fiction — and the next person to open it would
 * have no way to tell which parts were real. The most useful thing this file can contain
 * today is a refusal and a list of what is missing.
 *
 * `QubeMockInventoryProvider` is the sandbox that exercises the architecture. It is invented
 * in full and says so. This is the slot the real transport goes into.
 *
 * ── WHAT IS ACTUALLY UNKNOWN ───────────────────────────────────────────────────────
 * Everything below is a question, not an assumption:
 *   - base URLs (sandbox and production), API versioning, authentication scheme
 *   - whether seat holds exist at all, and if so their TTL and whether they can be extended
 *   - whether confirmation is idempotent, and what identifier makes it so
 *   - who owns the barcode: does Qube issue the scannable ticket, or do we?
 *   - whether a booking can be looked up after an ambiguous timeout — the single capability
 *     that decides whether reconciliation can be correct rather than merely careful
 *   - cancellation and partial-refund semantics, and whose fees apply
 *   - webhooks for show and seat changes, or polling only
 *   - rate limits, IP allowlisting, mTLS
 *   - whether ETicketsGo contracts with Qube or with each exhibitor
 *
 * See `docs/integrations/qube-readiness.md` for the full list to put to Qube.
 */
@Injectable()
export class QubeInventoryProvider implements InventoryProvider {
  readonly name = 'QUBE';
  readonly sourceKind: InventorySourceKind = 'AGGREGATOR';

  /**
   * Advertised as REMOTE and NOT failoverable, matching what a real cinema POS would be.
   *
   * Stated even though nothing works yet, so that if this provider is ever registered before
   * it is implemented, the resolver treats it with the right caution rather than discovering
   * the rules later. Seats owned by an exhibitor's system must never be failed over to local
   * stock — that is how a platform sells a seat it does not have.
   */
  readonly capabilities: InventoryProviderCapabilities = {
    search: true,
    authority: 'REMOTE',
    failover: false,
  };

  private notConfigured(op: string): never {
    throw new AppException(
      ErrorCodes.INVENTORY_PROVIDER_UNAVAILABLE,
      `QUBE_PROVIDER_NOT_CONFIGURED: the real Qube integration does not exist yet (${op}). ` +
        'It needs official API documentation, credentials and a sandbox — see ' +
        'docs/integrations/qube-readiness.md. Use QUBE_MOCK for sandbox work.',
      HttpStatus.NOT_IMPLEMENTED,
      { provider: this.name, op },
    );
  }

  async search(_query: SearchQuery): Promise<SearchResultItem[]> {
    void _query;
    return this.notConfigured('search');
  }
  async availability(_query: AvailabilityQuery): Promise<AvailabilitySnapshot> {
    void _query;
    return this.notConfigured('availability');
  }
  async lockInventory(_req: LockRequest): Promise<LockResult> {
    void _req;
    return this.notConfigured('lockInventory');
  }
  async confirmBooking(_ctx: InventoryWriteContext): Promise<ConfirmResult> {
    void _ctx;
    return this.notConfigured('confirmBooking');
  }
  async cancelBooking(_ctx: InventoryWriteContext): Promise<void> {
    void _ctx;
    return this.notConfigured('cancelBooking');
  }
  async refund(_req: RefundInventoryRequest): Promise<void> {
    void _req;
    return this.notConfigured('refund');
  }
  async sync(_req: SyncRequest): Promise<SyncResult> {
    void _req;
    return this.notConfigured('sync');
  }

  /**
   * Reports unhealthy rather than throwing, so the health monitor keeps it out of every
   * candidate set instead of the registry failing to start.
   */
  async health(): Promise<ProviderHealth> {
    return { healthy: false, reason: 'QUBE_PROVIDER_NOT_CONFIGURED', checkedAt: new Date() };
  }
}
