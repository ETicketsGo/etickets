import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { BookingWorkflow, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TransactionalEventPublisher } from '../../common/domain-events';
import {
  bookingAllocationConsumptionConfirmedEvent,
  bookingAllocationConsumptionHeldEvent,
  bookingAllocationConsumptionReleasedEvent,
} from '../../common/domain-events/catalogue/provider-compensation-events';
import {
  ExternalBookingException,
  ExternalBookingFailure,
} from '../providers/external-booking.errors';

/**
 * Authoritative, transactional ALLOCATED-inventory consumption accounting (ADR-042 P5.3A.1).
 * `heldLocal`/`confirmedLocal` on `ProviderInventoryState` are the source of truth for the
 * sellable boundary (`heldLocal + confirmedLocal <= providerCapacity`). The hold guard is an
 * ATOMIC guarded UPDATE inside the booking transaction — two concurrent bookings cannot both
 * pass it, so an allocation can never be oversold. Confirm (held→confirmed) and release
 * (held→free) are exactly-once per booking via the `allocationAccountingState` marker on
 * `BookingWorkflow`. Every mutation emits its allocation event through the P2.1 outbox in the
 * SAME transaction, so the consumption ledger is replayable.
 */
@Injectable()
export class AllocationAccountingService {
  private readonly logger = new Logger('AllocationAccounting');

  constructor(
    private readonly prisma: PrismaService,
    private readonly publisher: TransactionalEventPublisher,
  ) {}

  /**
   * Atomically reserve `qty` against an allocation INSIDE the caller's transaction. Returns
   * only if the capacity guard passed; throws ALLOCATION_EXHAUSTED otherwise (rolling back the
   * caller's booking hold). Also records the held event in the same tx.
   */
  async holdInTx(
    tx: Prisma.TransactionClient,
    ctx: {
      bookingId: string;
      workflowId?: string;
      providerCode: string;
      externalRef: string;
      qty: number;
      inventoryType: 'SEAT' | 'QUANTITY';
      correlationId?: string;
    },
  ): Promise<void> {
    // Guarded so heldLocal + confirmedLocal + qty never exceeds providerCapacity. A concurrent
    // booking that would breach capacity matches zero rows and is refused.
    const affected = await tx.$executeRaw`
      UPDATE "ProviderInventoryState"
      SET "heldLocal" = "heldLocal" + ${ctx.qty}, "version" = "version" + 1, "updatedAt" = NOW()
      WHERE "providerCode" = ${ctx.providerCode}
        AND "externalSessionId" = ${ctx.externalRef}
        AND "providerCapacity" IS NOT NULL
        AND "heldLocal" + "confirmedLocal" + ${ctx.qty} <= "providerCapacity"`;
    if (affected !== 1) {
      throw new ExternalBookingException(ExternalBookingFailure.ALLOCATION_EXHAUSTED, {
        reason: 'capacity_guard_failed',
      });
    }
    await this.publisher.recordInTransaction(tx, [
      bookingAllocationConsumptionHeldEvent(
        {
          bookingId: ctx.bookingId,
          workflowId: ctx.workflowId,
          providerCode: ctx.providerCode,
          ownershipMode: 'ALLOCATED',
          inventoryType: ctx.inventoryType,
          allocationId: ctx.externalRef,
          quantity: ctx.qty,
          occurredAt: new Date().toISOString(),
        },
        { correlationId: ctx.correlationId },
      ),
    ]);
  }

  /**
   * Move held→confirmed exactly once for a booking (guarded by the workflow marker). Runs in
   * its own transaction with the allocation event; safe to call on duplicate confirmations.
   */
  async confirmMove(workflow: BookingWorkflow): Promise<boolean> {
    return this.transition(workflow, 'HELD', 'CONFIRMED', async (tx, qty, ref) => {
      await tx.$executeRaw`
        UPDATE "ProviderInventoryState"
        SET "heldLocal" = GREATEST("heldLocal" - ${qty}, 0),
            "confirmedLocal" = "confirmedLocal" + ${qty},
            "version" = "version" + 1, "updatedAt" = NOW()
        WHERE "providerCode" = ${workflow.allocationProviderCode} AND "externalSessionId" = ${ref}`;
      return [
        bookingAllocationConsumptionConfirmedEvent(
          {
            bookingId: workflow.bookingId,
            workflowId: workflow.id,
            providerCode: workflow.allocationProviderCode ?? 'unknown',
            ownershipMode: 'ALLOCATED',
            allocationId: ref,
            quantity: qty,
            occurredAt: new Date().toISOString(),
          },
          { correlationId: workflow.correlationId ?? undefined },
        ),
      ];
    });
  }

  /** Release held consumption exactly once (expire / unpaid cancel), guarded by the marker. */
  async releaseHeld(workflow: BookingWorkflow, reason: string): Promise<boolean> {
    return this.transition(workflow, 'HELD', 'RELEASED', async (tx, qty, ref) => {
      await tx.$executeRaw`
        UPDATE "ProviderInventoryState"
        SET "heldLocal" = GREATEST("heldLocal" - ${qty}, 0), "version" = "version" + 1, "updatedAt" = NOW()
        WHERE "providerCode" = ${workflow.allocationProviderCode} AND "externalSessionId" = ${ref}`;
      return [
        bookingAllocationConsumptionReleasedEvent(
          {
            bookingId: workflow.bookingId,
            workflowId: workflow.id,
            providerCode: workflow.allocationProviderCode ?? 'unknown',
            ownershipMode: 'ALLOCATED',
            allocationId: ref,
            quantity: qty,
            category: reason,
            occurredAt: new Date().toISOString(),
          },
          { correlationId: workflow.correlationId ?? undefined },
        ),
      ];
    });
  }

  /**
   * Atomic marker flip + counter mutation + event in one tx. The guarded `updateMany` on
   * (id, allocationAccountingState=from) means exactly one caller performs the move; duplicate
   * callbacks / repeated sweeps see count 0 and no-op.
   */
  private async transition(
    workflow: BookingWorkflow,
    from: string,
    to: string,
    mutate: (
      tx: Prisma.TransactionClient,
      qty: number,
      ref: string,
    ) => Promise<import('../../common/domain-events').DomainEvent[]>,
  ): Promise<boolean> {
    if (workflow.inventoryOwnershipMode !== 'ALLOCATED') return false;
    const qty = workflow.allocationHeldQty ?? 0;
    const ref = workflow.allocationExternalRef;
    if (workflow.allocationAccountingState !== from || qty <= 0 || !ref) return false;
    const events = await this.prisma
      .$transaction(async (tx) => {
        const claim = await tx.bookingWorkflow.updateMany({
          where: { id: workflow.id, allocationAccountingState: from },
          data: { allocationAccountingState: to },
        });
        if (claim.count !== 1) return [];
        const evts = await mutate(tx, qty, ref);
        await this.publisher.recordInTransaction(tx, evts);
        return evts;
      })
      .catch((err) => {
        this.logger.error(
          `allocation ${from}→${to} failed for booking=${workflow.bookingId}`,
          err as Error,
        );
        throw err;
      });
    if (events.length === 0) return false;
    await this.publisher.deliverAfterCommit(events);
    return true;
  }

  /** Current authoritative consumption for an allocation (reconciliation / health). */
  async consumption(providerCode: string, externalRef: string) {
    const row = await this.prisma.providerInventoryState.findFirst({
      where: { providerCode, externalSessionId: externalRef },
      select: { heldLocal: true, confirmedLocal: true, providerCapacity: true },
    });
    return row ?? null;
  }

  /** Guard against a misconfigured caller passing a non-positive quantity. */
  static assertQty(qty: number): void {
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new ExternalBookingException(ExternalBookingFailure.ALLOCATION_EXHAUSTED, {
        reason: 'invalid_quantity',
        status: HttpStatus.BAD_REQUEST,
      });
    }
  }
}
