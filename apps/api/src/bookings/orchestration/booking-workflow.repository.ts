import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { BookingWorkflow, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BookingWorkflowState } from './booking-workflow-state';
import { assertTransition } from './booking-workflow.transitions';
import {
  BookingIdempotencyConflictError,
  BookingWorkflowConflictError,
} from './booking-orchestrator.errors';
import type { InventoryOwnershipMode } from '../../inventory/sync/contracts/canonical-change';

export interface CreateWorkflowInput {
  workflowType?: string;
  idempotencyKey: string;
  requestFingerprint: string;
  correlationId?: string;
  inventoryOwnershipMode: InventoryOwnershipMode;
  selectedProviderCode: string;
  /** Durable server-decided ownership (ADR-042 §4). */
  ownerType?: 'USER' | 'ANONYMOUS_SESSION' | 'INTERNAL';
  ownerId?: string;
  tenantId?: string;
  organizerId?: string;
}

/** The result of a guarded transition: applied, or an idempotent replay of the target state. */
export type AdvanceResult =
  | { outcome: 'ADVANCED'; workflow: BookingWorkflow }
  | { outcome: 'REPLAY'; workflow: BookingWorkflow };

/**
 * Durable BookingWorkflow persistence (ADR-042). The ONLY writer of the workflow row.
 * Transitions use optimistic concurrency (guarded UPDATE on id + version + state) so two
 * workers/callbacks cannot advance the same workflow inconsistently; a lost race that
 * already reached the target state is treated as an idempotent replay, otherwise a
 * conflict is raised. Idempotency-key reuse with a different request fingerprint fails
 * with a typed conflict.
 */
@Injectable()
export class BookingWorkflowRepository {
  constructor(private readonly prisma: PrismaService) {}

  static fingerprint(parts: (string | number | undefined)[]): string {
    return createHash('sha256')
      .update(parts.map((p) => p ?? '').join('|'))
      .digest('hex')
      .slice(0, 32);
  }

  /** Idempotent create: same key + same fingerprint returns the existing workflow. */
  async createOrGet(
    input: CreateWorkflowInput,
  ): Promise<{ workflow: BookingWorkflow; created: boolean }> {
    const workflowType = input.workflowType ?? 'BOOKING';
    const existing = await this.prisma.bookingWorkflow.findUnique({
      where: {
        workflowType_idempotencyKey: { workflowType, idempotencyKey: input.idempotencyKey },
      },
    });
    if (existing) {
      if (existing.requestFingerprint && existing.requestFingerprint !== input.requestFingerprint) {
        throw new BookingIdempotencyConflictError({ idempotencyKey: input.idempotencyKey });
      }
      return { workflow: existing, created: false };
    }
    try {
      const workflow = await this.prisma.bookingWorkflow.create({
        data: {
          workflowType,
          bookingId: `pending-${input.idempotencyKey}`, // replaced with the real bookingId at hold time
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
          correlationId: input.correlationId ?? null,
          inventoryOwnershipMode: input.inventoryOwnershipMode,
          selectedProviderCode: input.selectedProviderCode,
          ownerType: input.ownerType ?? null,
          ownerId: input.ownerId ?? null,
          tenantId: input.tenantId ?? null,
          organizerId: input.organizerId ?? null,
          state: BookingWorkflowState.DRAFT,
        },
      });
      return { workflow, created: true };
    } catch (err) {
      // Concurrent create with the same key → load + fingerprint-check.
      if (this.isUnique(err)) {
        const w = await this.prisma.bookingWorkflow.findUnique({
          where: {
            workflowType_idempotencyKey: { workflowType, idempotencyKey: input.idempotencyKey },
          },
        });
        if (w) {
          if (w.requestFingerprint && w.requestFingerprint !== input.requestFingerprint) {
            throw new BookingIdempotencyConflictError({ idempotencyKey: input.idempotencyKey });
          }
          return { workflow: w, created: false };
        }
      }
      throw err;
    }
  }

  get(id: string): Promise<BookingWorkflow | null> {
    return this.prisma.bookingWorkflow.findUnique({ where: { id } });
  }

  getByBookingId(bookingId: string): Promise<BookingWorkflow | null> {
    return this.prisma.bookingWorkflow.findUnique({ where: { bookingId } });
  }

  /**
   * Guarded optimistic-concurrency transition. Validates the move against the matrix,
   * then applies it only if (id, version, state) still match. Returns REPLAY when the
   * row is already in the target state (idempotent), else raises a conflict.
   */
  async advance(
    workflow: BookingWorkflow,
    nextState: BookingWorkflowState,
    patch: Prisma.BookingWorkflowUpdateInput = {},
    tx?: Prisma.TransactionClient,
  ): Promise<AdvanceResult> {
    const from = workflow.state as BookingWorkflowState;
    if (from === nextState) return { outcome: 'REPLAY', workflow };
    assertTransition(from, nextState); // throws InvalidBookingTransitionError

    const client = tx ?? this.prisma;
    const res = await client.bookingWorkflow.updateMany({
      where: { id: workflow.id, version: workflow.version, state: from },
      data: {
        ...(patch as Prisma.BookingWorkflowUncheckedUpdateManyInput),
        state: nextState,
        version: { increment: 1 },
      },
    });
    if (res.count === 1) {
      const updated = (await client.bookingWorkflow.findUnique({
        where: { id: workflow.id },
      })) as BookingWorkflow;
      return { outcome: 'ADVANCED', workflow: updated };
    }
    // Lost the race — reload and decide replay vs conflict.
    const current = await client.bookingWorkflow.findUnique({ where: { id: workflow.id } });
    if (current && current.state === nextState) return { outcome: 'REPLAY', workflow: current };
    throw new BookingWorkflowConflictError({ workflowId: workflow.id, from, to: nextState });
  }

  /** Bind the real bookingId + provider/lock/payment metadata once the hold is created. */
  async attachBooking(
    id: string,
    data: { bookingId: string; lockId?: string; fencingToken?: number; paymentProvider?: string },
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.prisma;
    await client.bookingWorkflow.update({ where: { id }, data });
  }

  private isUnique(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
  }
}
