import { HttpStatus } from '@nestjs/common';
import { AppException, ErrorCodes } from '../../../common/errors';
import { PrismaService } from '../../../prisma/prisma.service';
import { InventoryService } from '../../inventory.service';
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
import type { ReserveContext } from '../../inventory-strategy.interface';

/**
 * Base for inventory that lives in OUR OWN database. Both the Direct (theatre
 * integrated directly with ETicketsGo) and Manual (portal-entered) sources are
 * LOCAL and authoritative, so they share all behaviour and differ only in `name`
 * and `sourceKind` (provenance) — no duplicated logic.
 *
 * Every write delegates to the existing {@link InventoryStrategy} for the
 * experience type (ADR-010), so this seam adds NO new inventory maths and preserves
 * the oversell guarantee exactly. When the caller supplies a transaction (`ctx.tx`)
 * the write composes into it (atomic with the booking); otherwise the provider opens
 * its own transaction.
 */
export abstract class LocalInventoryProvider implements InventoryProvider {
  abstract readonly name: string;
  abstract readonly sourceKind: InventorySourceKind;

  // LOCAL stock is single-sourced and authoritative: it is never failed over to a
  // different provider, and search is owned by the discovery domain (not duplicated
  // here). Both are reflected in capabilities so the resolver routes correctly.
  readonly capabilities: InventoryProviderCapabilities = {
    search: false,
    authority: 'LOCAL',
    failover: false,
  };

  constructor(
    protected readonly inventory: InventoryService,
    protected readonly prisma: PrismaService,
  ) {}

  /**
   * Catalogue search for local stock is served by the discovery domain, not the
   * sourcing provider. We expose the uniform method but refuse honestly rather than
   * duplicate discovery here.
   */
  async search(_query: SearchQuery): Promise<SearchResultItem[]> {
    void _query;
    throw new AppException(
      ErrorCodes.INVENTORY_SOURCE_UNSUPPORTED,
      `${this.name} does not serve catalogue search; use the discovery service.`,
      HttpStatus.NOT_IMPLEMENTED,
    );
  }

  async availability(query: AvailabilityQuery): Promise<AvailabilitySnapshot> {
    const strategy = this.inventory.forExperienceType(query.experienceType);
    const client = query.client ?? this.prisma;
    const map = await strategy.availability(client, query.ticketTypeIds);
    const unitsByTicketType: Record<string, number> = {};
    for (const [ticketTypeId, units] of map) unitsByTicketType[ticketTypeId] = units;
    return { unitsByTicketType, asOf: new Date(), authority: 'LOCAL' };
  }

  async lockInventory(req: LockRequest): Promise<LockResult> {
    const strategy = this.inventory.forExperienceType(req.experienceType);
    const reserveCtx: ReserveContext = {
      eventSessionId: req.eventSessionId,
      bookingId: req.bookingId,
      holdExpiresAt: req.holdExpiresAt,
      lines: req.lines,
    };
    if (req.tx) {
      await strategy.reserve(req.tx, reserveCtx);
    } else {
      await this.prisma.$transaction((tx) => strategy.reserve(tx, reserveCtx));
    }
    // For LOCAL stock the booking id IS the hold handle (quantityHeld is stamped
    // against the booking's lines); there is no separate vendor lock id.
    return { lockRef: req.bookingId, expiresAt: req.holdExpiresAt, authority: 'LOCAL' };
  }

  async confirmBooking(ctx: InventoryWriteContext): Promise<ConfirmResult> {
    const strategy = this.inventory.forExperienceType(ctx.experienceType);
    // `holdExpiresAt` is part of ReserveContext but unused by confirm/release; the
    // sentinel is never read (verified in the strategy implementations, ADR-010).
    const reserveCtx = this.reserveContext(ctx);
    const tickets = ctx.tx
      ? await strategy.confirm(ctx.tx, reserveCtx)
      : await this.prisma.$transaction((tx) => strategy.confirm(tx, reserveCtx));
    return { confirmationRef: ctx.bookingId, tickets };
  }

  async cancelBooking(ctx: InventoryWriteContext): Promise<void> {
    const strategy = this.inventory.forExperienceType(ctx.experienceType);
    const reserveCtx = this.reserveContext(ctx);
    if (ctx.tx) {
      await strategy.release(ctx.tx, reserveCtx);
    } else {
      await this.prisma.$transaction((tx) => strategy.release(tx, reserveCtx));
    }
  }

  async refund(req: RefundInventoryRequest): Promise<void> {
    const strategy = this.inventory.forExperienceType(req.experienceType);
    const refundCtx = {
      eventSessionId: req.eventSessionId,
      tickets: req.tickets.map((t) => ({ ticketTypeId: t.ticketTypeId, seatId: t.seatId })),
    };
    if (req.tx) {
      await strategy.refund(req.tx, refundCtx);
    } else {
      await this.prisma.$transaction((tx) => strategy.refund(tx, refundCtx));
    }
  }

  /** LOCAL stock is always consistent with itself — sync is a no-op reconciliation. */
  async sync(_req: SyncRequest): Promise<SyncResult> {
    void _req;
    return { itemsReconciled: 0, authority: 'LOCAL' };
  }

  /** Healthy iff the database is reachable (a single trivial round-trip). */
  async health(): Promise<ProviderHealth> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { healthy: true, checkedAt: new Date() };
    } catch {
      return { healthy: false, reason: 'database_unreachable', checkedAt: new Date() };
    }
  }

  private reserveContext(ctx: InventoryWriteContext): ReserveContext {
    return {
      eventSessionId: ctx.eventSessionId,
      bookingId: ctx.bookingId,
      holdExpiresAt: new Date(0),
      lines: ctx.lines,
    };
  }
}
