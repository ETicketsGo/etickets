import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from '../../metrics/metrics.service';
import { CacheService } from '../../cache/cache.service';
import {
  DOMAIN_EVENT_BUS,
  type DomainEvent,
  type DomainEventBus,
  pricingUpdatedEvent,
  providerMappingReviewRequiredEvent,
  quantityAvailabilityUpdatedEvent,
  seatAvailabilityUpdatedEvent,
  sessionCancelledEvent,
  sessionUpdatedEvent,
  experienceUpdatedEvent,
} from '../../common/domain-events';
import { ProviderSyncOrderingConflictError } from './sync.errors';
import type {
  CanonicalInventoryChange,
  InventoryOwnershipMode,
} from './contracts/canonical-change';

export interface ApplyContext {
  providerCode: string;
  providerTenantId: string;
  defaultOwnershipMode: InventoryOwnershipMode;
  correlationId?: string;
}

export interface ApplyOutcome {
  applied: boolean;
  /** Why not applied, when applicable: stale | duplicate_version | local_authoritative. */
  reason?: string;
}

/**
 * Applies a canonical change to ETicketsGo state (ADR-040 §12). Sequence is strict:
 * load mapping → validate ownership/scope → version/timestamp ordering → transactional
 * mutation of the ADVISORY provider-imported state (never authoritative local
 * inventory) → commit → cache invalidation → domain events. Cache/events happen ONLY
 * after commit. Imported availability never overwrites local sold/held state; provider
 * booking/refund status is recorded advisory-only and never auto-cancels/refunds a
 * confirmed local booking. Uses the P2 DomainEventBus (no BullMQ in this service).
 */
@Injectable()
export class SyncApplicationService {
  private readonly logger = new Logger('SyncApplication');

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
    private readonly cache: CacheService,
    @Inject(DOMAIN_EVENT_BUS) private readonly events: DomainEventBus,
  ) {}

  async apply(change: CanonicalInventoryChange, ctx: ApplyContext): Promise<ApplyOutcome> {
    const { entityType, entityId } = this.mappingTarget(change);
    const hash = this.hash(JSON.stringify(change));
    const emitted: DomainEvent[] = [];
    let sessionInvalidated = false;

    const outcome = await this.prisma.$transaction(async (tx) => {
      const mapping = await this.loadOrCreateMapping(tx, ctx, entityType, entityId);
      const ownershipMode = mapping.ownershipMode as InventoryOwnershipMode;

      const ordering = this.orderingVerdict(change, mapping, hash);
      if (ordering === 'stale') {
        this.metrics.recordSyncApply(ctx.providerCode, 'stale');
        return { applied: false, reason: 'stale' } as ApplyOutcome;
      }
      if (ordering === 'conflict') {
        // Same version, different payload — never guess; escalate to review.
        emitted.push(
          providerMappingReviewRequiredEvent(
            {
              providerCode: ctx.providerCode,
              externalEntityType: entityType,
              externalEntityId: entityId,
              reason: 'ordering_conflict',
            },
            { correlationId: ctx.correlationId },
          ),
        );
        this.metrics.recordSyncApply(ctx.providerCode, 'ordering_conflict');
        throw new ProviderSyncOrderingConflictError({ entityType });
      }

      // Availability/pricing imports respect ownership: LOCAL_AUTHORITATIVE never imports.
      const isAvailabilityImport =
        change.kind === 'UPDATE_SEAT_AVAILABILITY' ||
        change.kind === 'UPDATE_QUANTITY_AVAILABILITY';
      if (isAvailabilityImport && ownershipMode === 'LOCAL_AUTHORITATIVE') {
        this.metrics.recordSyncApply(ctx.providerCode, 'local_authoritative_ignored');
        await this.touchMapping(tx, mapping.id, change, hash);
        return { applied: false, reason: 'local_authoritative' } as ApplyOutcome;
      }

      sessionInvalidated = await this.applyMutation(tx, ctx, change, emitted);
      await this.touchMapping(tx, mapping.id, change, hash);
      this.metrics.recordSyncApply(ctx.providerCode, 'applied');
      return { applied: true } as ApplyOutcome;
    });

    // ── after commit only ──
    if (outcome.applied) {
      await this.invalidateCache(ctx, sessionInvalidated);
    }
    if (emitted.length > 0) {
      try {
        await this.events.publishMany(emitted);
      } catch {
        this.logger.error(`post-commit event publish failed for provider=${ctx.providerCode}`);
      }
    }
    return outcome;
  }

  /** Which mapping entity a change targets (availability/pricing/cancel → SESSION). */
  private mappingTarget(change: CanonicalInventoryChange): {
    entityType: string;
    entityId: string;
  } {
    switch (change.kind) {
      case 'UPDATE_SEAT_AVAILABILITY':
      case 'UPDATE_QUANTITY_AVAILABILITY':
      case 'UPDATE_PRICING':
        return { entityType: 'SESSION', entityId: change.externalSessionId };
      case 'CANCEL_SESSION':
        return { entityType: 'SESSION', entityId: change.externalSessionId };
      case 'PROVIDER_BOOKING_STATUS':
        return { entityType: 'BOOKING', entityId: change.externalBookingId };
      case 'PROVIDER_REFUND_STATUS':
        return { entityType: 'REFUND', entityId: change.externalRefundId };
      default:
        return { entityType: change.externalEntityType, entityId: change.externalEntityId };
    }
  }

  private async loadOrCreateMapping(
    tx: Prisma.TransactionClient,
    ctx: ApplyContext,
    entityType: string,
    entityId: string,
  ) {
    const where = {
      providerCode_providerTenantId_externalEntityType_externalEntityId: {
        providerCode: ctx.providerCode,
        providerTenantId: ctx.providerTenantId,
        externalEntityType: entityType,
        externalEntityId: entityId,
      },
    };
    const existing = await tx.providerMapping.findUnique({ where });
    if (existing) return existing;
    return tx.providerMapping.create({
      data: {
        providerCode: ctx.providerCode,
        providerTenantId: ctx.providerTenantId,
        externalEntityType: entityType,
        externalEntityId: entityId,
        ownershipMode: ctx.defaultOwnershipMode,
        status: 'UNMAPPED', // no internal entity linked yet — resolved by ops
      },
    });
  }

  /** Ordering rule: newer version applies; older is stale; equal+diff-hash is a conflict. */
  private orderingVerdict(
    change: CanonicalInventoryChange,
    mapping: {
      externalVersion: number | null;
      lastProviderUpdatedAt: Date | null;
      mappingMetadata: unknown;
    },
    hash: string,
  ): 'apply' | 'stale' | 'conflict' {
    const incoming = change.externalVersion ?? null;
    const stored = mapping.externalVersion ?? null;
    if (incoming !== null && stored !== null) {
      if (incoming > stored) return 'apply';
      if (incoming < stored) return 'stale';
      // equal version: duplicate if same payload hash, else an ordering conflict.
      const lastHash = (mapping.mappingMetadata as { lastHash?: string } | null)?.lastHash;
      return lastHash === hash ? 'stale' : 'conflict';
    }
    // Timestamp fallback (no versions): older provider time is stale.
    if (change.providerOccurredAt && mapping.lastProviderUpdatedAt) {
      const t = new Date(change.providerOccurredAt).getTime();
      const stamp = mapping.lastProviderUpdatedAt.getTime();
      if (t < stamp) return 'stale';
    }
    return 'apply';
  }

  /** Apply the change to ADVISORY provider state; returns true if a session cache should be invalidated. */
  private async applyMutation(
    tx: Prisma.TransactionClient,
    ctx: ApplyContext,
    change: CanonicalInventoryChange,
    emitted: DomainEvent[],
  ): Promise<boolean> {
    const t = { correlationId: ctx.correlationId };
    switch (change.kind) {
      case 'UPDATE_SEAT_AVAILABILITY': {
        const version = change.externalVersion ?? 0;
        await this.upsertInventoryState(tx, ctx, change.externalSessionId, {
          seatStates: change.seats as unknown as Prisma.InputJsonValue,
          layoutVersion: change.layoutVersion,
          version,
        });
        emitted.push(
          seatAvailabilityUpdatedEvent(
            {
              providerCode: ctx.providerCode,
              externalSessionId: change.externalSessionId,
              changedSeats: change.seats.length,
              version,
            },
            t,
          ),
        );
        return true;
      }
      case 'UPDATE_QUANTITY_AVAILABILITY': {
        const version = change.externalVersion ?? 0;
        await this.upsertInventoryState(tx, ctx, change.externalSessionId, {
          providerRemaining: change.remaining,
          providerCapacity: change.capacity ?? null,
          version,
        });
        emitted.push(
          quantityAvailabilityUpdatedEvent(
            {
              providerCode: ctx.providerCode,
              externalSessionId: change.externalSessionId,
              remaining: change.remaining,
              version,
            },
            t,
          ),
        );
        return true;
      }
      case 'UPDATE_PRICING':
        emitted.push(
          pricingUpdatedEvent(
            {
              providerCode: ctx.providerCode,
              externalSessionId: change.externalSessionId,
              tiers: change.tiers.length,
            },
            t,
          ),
        );
        return true;
      case 'UPSERT_SESSION':
        emitted.push(
          sessionUpdatedEvent(
            {
              providerCode: ctx.providerCode,
              externalSessionId: change.externalEntityId,
              status: change.status,
            },
            t,
          ),
        );
        return true;
      case 'CANCEL_SESSION':
        // Advisory: mark the imported session cancelled; never cancel local bookings.
        await this.upsertInventoryState(tx, ctx, change.externalSessionId, {
          version: change.externalVersion ?? 0,
        });
        emitted.push(
          sessionCancelledEvent(
            {
              providerCode: ctx.providerCode,
              externalSessionId: change.externalSessionId,
              status: 'CANCELLED',
            },
            t,
          ),
        );
        return true;
      case 'UPSERT_EXPERIENCE':
        emitted.push(
          experienceUpdatedEvent(
            { providerCode: ctx.providerCode, externalExperienceId: change.externalEntityId },
            t,
          ),
        );
        return false;
      default:
        // UPSERT_VENUE/SCREEN/SEAT_LAYOUT + PROVIDER_BOOKING/REFUND_STATUS: mapping
        // metadata is updated by touchMapping; booking/refund are advisory-only and
        // never mutate a confirmed local booking (booking review, ADR-040 §19).
        return false;
    }
  }

  private async upsertInventoryState(
    tx: Prisma.TransactionClient,
    ctx: ApplyContext,
    externalSessionId: string,
    data: Prisma.ProviderInventoryStateUncheckedUpdateInput &
      Partial<Prisma.ProviderInventoryStateUncheckedCreateInput>,
  ): Promise<void> {
    await tx.providerInventoryState.upsert({
      where: {
        providerCode_providerTenantId_externalSessionId: {
          providerCode: ctx.providerCode,
          providerTenantId: ctx.providerTenantId,
          externalSessionId,
        },
      },
      create: {
        providerCode: ctx.providerCode,
        providerTenantId: ctx.providerTenantId,
        externalSessionId,
        ownershipMode: ctx.defaultOwnershipMode,
        providerUpdatedAt: new Date(),
        ...data,
      } as Prisma.ProviderInventoryStateUncheckedCreateInput,
      update: { ...data, providerUpdatedAt: new Date() },
    });
  }

  private async touchMapping(
    tx: Prisma.TransactionClient,
    mappingId: string,
    change: CanonicalInventoryChange,
    hash: string,
  ): Promise<void> {
    await tx.providerMapping.update({
      where: { id: mappingId },
      data: {
        externalVersion: change.externalVersion ?? undefined,
        lastProviderUpdatedAt: change.providerOccurredAt
          ? new Date(change.providerOccurredAt)
          : undefined,
        lastSyncedAt: new Date(),
        mappingMetadata: { lastHash: hash } as Prisma.InputJsonValue,
      },
    });
  }

  private async invalidateCache(ctx: ApplyContext, sessionInvalidated: boolean): Promise<void> {
    if (!sessionInvalidated) return;
    // Targeted, best-effort, observable — never flush unrelated keys, never roll back.
    const removed = await this.cache.invalidateByPattern(`etg:cache:session:*`);
    if (removed < 0) this.metrics.recordSyncApply(ctx.providerCode, 'cache_invalidation_failed');
  }

  private hash(s: string): string {
    return createHash('sha256').update(s).digest('hex').slice(0, 32);
  }
}
