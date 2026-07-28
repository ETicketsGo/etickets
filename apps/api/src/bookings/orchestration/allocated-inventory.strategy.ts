import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../../metrics/metrics.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ExternalBookingException,
  ExternalBookingFailure,
} from '../providers/external-booking.errors';

/** A resolved provider allocation descriptor (built from P4 mapping + inventory state). */
export interface AllocationDescriptor {
  providerCode: string;
  providerTenantId: string;
  allocationId: string;
  inventoryType: 'SEAT' | 'QUANTITY';
  status: string; // ACTIVE | SUSPENDED | EXPIRED | CANCELLED | MANUAL_REVIEW | EXHAUSTED
  startsAt?: Date | null;
  expiresAt?: Date | null;
  capacity?: number | null;
  allocatedSeatRefs?: string[];
  /** Locally held + confirmed units already counted against the allocation. */
  localConsumed?: number;
}

export interface AllocationRequest {
  inventoryType: 'SEAT' | 'QUANTITY';
  seatRefs?: string[];
  quantity?: number;
}

/**
 * Allocated-inventory boundary validation (ADR-042 §15–§19, P5.2B Slice 4). Allocated
 * inventory is LOCALLY AUTHORITATIVE within a bounded provider allocation: the booking runs
 * the normal local-authoritative flow (Redis lock + PostgreSQL hold + local confirm), and
 * this strategy only enforces the allocation boundary — active status, effective window, seat
 * membership, and capacity — using P4 `ProviderMapping` + `ProviderInventoryState` (no new
 * model, no per-booking provider call). PostgreSQL stays authoritative; advisory provider
 * availability never overrides locally sold inventory. Gated by
 * `BOOKING_ALLOCATED_INVENTORY_ENABLED`.
 */
@Injectable()
export class AllocatedInventoryStrategy {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
  ) {}

  get enabled(): boolean {
    return this.config.get<boolean>('BOOKING_ALLOCATED_INVENTORY_ENABLED') === true;
  }

  /** Resolve the allocation descriptor for an event from durable P4 data (null if none). */
  async resolve(eventId: string, now = new Date()): Promise<AllocationDescriptor | null> {
    const mapping = await this.prisma.providerMapping.findFirst({
      where: { internalEntityType: 'event', internalEntityId: eventId, ownershipMode: 'ALLOCATED' },
    });
    if (!mapping) return null;
    const state = await this.prisma.providerInventoryState.findFirst({
      where: { providerCode: mapping.providerCode, externalSessionId: mapping.externalEntityId },
    });
    const meta = (mapping.mappingMetadata ?? {}) as Record<string, unknown>;
    const seatStates = (state?.seatStates ?? undefined) as Record<string, unknown> | undefined;
    void now;
    return {
      providerCode: mapping.providerCode,
      providerTenantId: mapping.providerTenantId,
      allocationId: mapping.externalEntityId,
      inventoryType: seatStates ? 'SEAT' : 'QUANTITY',
      status:
        typeof meta.allocationStatus === 'string' ? (meta.allocationStatus as string) : 'ACTIVE',
      startsAt: typeof meta.startsAt === 'string' ? new Date(meta.startsAt) : null,
      expiresAt: typeof meta.expiresAt === 'string' ? new Date(meta.expiresAt) : null,
      capacity: state?.providerCapacity ?? null,
      allocatedSeatRefs: seatStates ? Object.keys(seatStates) : undefined,
      localConsumed: state?.pendingLocal ?? 0,
    };
  }

  /**
   * Validate a booking request against the allocation boundary. Throws a safe, typed
   * ExternalBookingException on any violation; new bookings are blocked while existing
   * confirmed bookings are never invalidated here. Returns silently when valid.
   */
  validate(alloc: AllocationDescriptor, request: AllocationRequest, now = new Date()): void {
    const type = request.inventoryType;
    // Status: only ACTIVE allocations accept new bookings.
    if (alloc.status !== 'ACTIVE') {
      const failure =
        alloc.status === 'EXPIRED'
          ? ExternalBookingFailure.ALLOCATION_EXPIRED
          : alloc.status === 'EXHAUSTED'
            ? ExternalBookingFailure.ALLOCATION_EXHAUSTED
            : ExternalBookingFailure.ALLOCATION_SUSPENDED;
      this.metrics.recordAllocationValidation(alloc.status.toLowerCase(), type);
      throw new ExternalBookingException(failure, { allocationStatus: alloc.status });
    }
    // Effective window.
    if ((alloc.startsAt && now < alloc.startsAt) || (alloc.expiresAt && now >= alloc.expiresAt)) {
      this.metrics.recordAllocationValidation('window', type);
      throw new ExternalBookingException(ExternalBookingFailure.ALLOCATION_EXPIRED, {
        window: true,
      });
    }
    if (type === 'SEAT') {
      const requested = request.seatRefs ?? [];
      const allowed = new Set(alloc.allocatedSeatRefs ?? []);
      const outside = requested.filter((s) => !allowed.has(s));
      if (outside.length > 0) {
        this.metrics.recordAllocationValidation('seat_outside', type);
        throw new ExternalBookingException(ExternalBookingFailure.ALLOCATION_EXHAUSTED, {
          reason: 'seat_outside_allocation',
          count: outside.length,
        });
      }
    } else {
      // GA: locally consumed + requested must not exceed allocation capacity.
      const requested = request.quantity ?? 0;
      const consumed = alloc.localConsumed ?? 0;
      const capacity = alloc.capacity ?? 0;
      if (capacity > 0 && consumed + requested > capacity) {
        this.metrics.recordAllocationValidation('exhausted', type);
        throw new ExternalBookingException(ExternalBookingFailure.ALLOCATION_EXHAUSTED, {
          capacity,
          consumed,
          requested,
        });
      }
    }
    this.metrics.recordAllocationValidation('ok', type);
  }

  /** Reconciliation classification for an allocation vs local state (never auto-cancels). */
  classify(alloc: AllocationDescriptor | null, localHeldPlusConfirmed: number): string {
    if (!alloc) return 'ALLOCATION_MAPPING_MISSING';
    if (alloc.capacity != null && localHeldPlusConfirmed > alloc.capacity) {
      return 'ALLOCATION_CAPACITY_MISMATCH';
    }
    if (alloc.status === 'EXPIRED' && localHeldPlusConfirmed > 0)
      return 'ALLOCATION_EXPIRED_WITH_ACTIVE_HOLDS';
    if (alloc.status === 'SUSPENDED' && localHeldPlusConfirmed > 0)
      return 'ALLOCATION_SUSPENDED_WITH_ACTIVE_BOOKINGS';
    return 'IN_SYNC';
  }
}
