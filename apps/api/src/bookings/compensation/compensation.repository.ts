import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { BookingCompensation, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CompensationState, assertCompensationTransition } from './compensation-state';
import type { CompensationAction } from './compensation-types';

export interface PlanCompensationInput {
  bookingId: string;
  workflowId?: string;
  tenantId?: string;
  generation?: number;
  correlationId?: string;
  paymentProvider?: string;
  paymentReference?: string;
  externalProviderCode?: string;
  providerReservationId?: string;
  providerBookingId?: string;
  maxAttempts?: number;
}

/**
 * Durable compensation persistence (ADR-043). The ONLY writer of `BookingCompensation`.
 * Planning is idempotent via the DB unique `(bookingId, type, target, generation)` — a
 * concurrent planner loses the race and re-reads the existing row. State changes use
 * optimistic concurrency (guarded UPDATE on id+version+state); workers claim READY rows with a
 * lease and stale leases are recoverable. Server-generated idempotency keys back the executor's
 * provider/payment idempotency so retries never double-act.
 */
@Injectable()
export class CompensationRepository {
  constructor(private readonly prisma: PrismaService) {}

  static idempotencyKey(
    bookingId: string,
    type: string,
    target: string,
    generation: number,
  ): string {
    return createHash('sha256')
      .update([bookingId, type, target, generation].join('|'))
      .digest('hex')
      .slice(0, 40);
  }

  /** Idempotently create (or return) the compensation row for one planned action. */
  async createOrGet(
    action: CompensationAction,
    input: PlanCompensationInput,
  ): Promise<{ compensation: BookingCompensation; created: boolean }> {
    const generation = input.generation ?? 1;
    const idempotencyKey = CompensationRepository.idempotencyKey(
      input.bookingId,
      action.compensationType,
      action.targetReference,
      generation,
    );
    try {
      const compensation = await this.prisma.bookingCompensation.create({
        data: {
          bookingId: input.bookingId,
          workflowId: input.workflowId ?? null,
          tenantId: input.tenantId ?? null,
          compensationType: action.compensationType as never,
          reasonCode: action.reasonCode,
          targetReference: action.targetReference,
          generation,
          autoExecutable: action.autoExecutable,
          amountMinor: action.amountMinor ?? null,
          currency: action.currency ?? null,
          idempotencyKey,
          maxAttempts: input.maxAttempts ?? 5,
          paymentProvider: input.paymentProvider ?? null,
          paymentReference: input.paymentReference ?? null,
          externalProviderCode: input.externalProviderCode ?? null,
          providerReservationId: input.providerReservationId ?? null,
          providerBookingId: input.providerBookingId ?? null,
          correlationId: input.correlationId ?? null,
          state: CompensationState.PLANNED as never,
        },
      });
      return { compensation, created: true };
    } catch (err) {
      if (this.isUnique(err)) {
        const existing = await this.prisma.bookingCompensation.findUnique({
          where: { idempotencyKey },
        });
        if (existing) return { compensation: existing, created: false };
      }
      throw err;
    }
  }

  get(id: string): Promise<BookingCompensation | null> {
    return this.prisma.bookingCompensation.findUnique({ where: { id } });
  }

  listForBooking(bookingId: string): Promise<BookingCompensation[]> {
    return this.prisma.bookingCompensation.findMany({
      where: { bookingId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Guarded optimistic-concurrency state change. Returns the updated row, or null on a lost race. */
  async advance(
    comp: BookingCompensation,
    nextState: CompensationState,
    patch: Prisma.BookingCompensationUpdateInput = {},
  ): Promise<BookingCompensation | null> {
    const from = comp.state as CompensationState;
    if (from !== nextState) assertCompensationTransition(from, nextState);
    const res = await this.prisma.bookingCompensation.updateMany({
      where: { id: comp.id, version: comp.version, state: from as never },
      data: {
        ...(patch as Prisma.BookingCompensationUncheckedUpdateManyInput),
        state: nextState as never,
        version: { increment: 1 },
      },
    });
    if (res.count !== 1) return null;
    return this.prisma.bookingCompensation.findUnique({ where: { id: comp.id } });
  }

  /**
   * Atomically claim up to `limit` due READY rows for one worker with a lease. Each claim is a
   * guarded update (id+version+state=READY) so two workers never claim the same row.
   */
  async claimReady(
    workerId: string,
    leaseSeconds: number,
    limit: number,
    now = new Date(),
  ): Promise<BookingCompensation[]> {
    const due = await this.prisma.bookingCompensation.findMany({
      where: { state: CompensationState.READY as never, availableAt: { lte: now } },
      orderBy: { availableAt: 'asc' },
      take: limit,
    });
    const claimed: BookingCompensation[] = [];
    const lockExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);
    for (const row of due) {
      const updated = await this.advance(row, CompensationState.PROCESSING, {
        lockedBy: workerId,
        lockedAt: now,
        lockExpiresAt,
        lastAttemptAt: now,
        attemptCount: { increment: 1 },
      });
      if (updated) claimed.push(updated);
    }
    return claimed;
  }

  /** Recover PROCESSING rows whose lease has expired back to READY (idempotent). */
  async recoverStaleLeases(now = new Date()): Promise<number> {
    const res = await this.prisma.bookingCompensation.updateMany({
      where: { state: CompensationState.PROCESSING as never, lockExpiresAt: { lt: now } },
      data: {
        state: CompensationState.READY as never,
        lockedBy: null,
        lockedAt: null,
        lockExpiresAt: null,
      },
    });
    return res.count;
  }

  /** Bounded-backoff retry, or dead-letter once attempts are exhausted. */
  async scheduleRetryOrDeadLetter(
    comp: BookingCompensation,
    backoffSeconds: number,
    errorCode: string,
    now = new Date(),
  ): Promise<BookingCompensation | null> {
    if (comp.attemptCount >= comp.maxAttempts) {
      return this.advance(comp, CompensationState.DEAD_LETTERED, {
        failedAt: now,
        lastErrorCode: errorCode,
      });
    }
    const failed = await this.advance(comp, CompensationState.RETRYABLE_FAILURE, {
      lastErrorCode: errorCode,
    });
    if (!failed) return null;
    return this.advance(failed, CompensationState.READY, {
      availableAt: new Date(now.getTime() + backoffSeconds * 1000),
      lockedBy: null,
      lockedAt: null,
      lockExpiresAt: null,
    });
  }

  private isUnique(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
  }
}
