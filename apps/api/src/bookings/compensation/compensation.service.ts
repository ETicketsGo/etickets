import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BookingCompensation } from '@prisma/client';
import { MetricsService } from '../../metrics/metrics.service';
import { InventoryLockService } from '../../inventory/locking/inventory-lock.service';
import { BookingConfirmationBridge } from '../orchestration/booking-confirmation-bridge';
import { PaymentVoidExecutor } from './payment-void.executor';
import { CompensationPlanner, type CompensationContext } from './compensation-planner';
import { CompensationRepository, type PlanCompensationInput } from './compensation.repository';
import { CompensationState } from './compensation-state';
import {
  CompensationType,
  FINANCIAL_ACTIONS,
  SAFE_NON_FINANCIAL_ACTIONS,
} from './compensation-types';

/**
 * Orchestrates compensation PLANNING and SAFE execution (ADR-043). Everything is behind
 * flags, all off by default:
 *   - `BOOKING_COMPENSATION_PLANNING_ENABLED` → convert discrepancies into durable, idempotent
 *     compensation records (no execution).
 *   - `BOOKING_COMPENSATION_EXECUTION_ENABLED` → a worker may execute ONLY the safe
 *     non-financial actions (Redis lock release, unpaid hold release, provider status
 *     recovery, local confirmation retry).
 * Money-moving actions (void/refund) and confirmed-provider-booking cancellation are PLANNED
 * but never auto-executed in P5.3A — they go to MANUAL_REVIEW. No record is ever created from
 * client input; the planner's inputs are all server-derived.
 */
@Injectable()
export class CompensationService {
  constructor(
    private readonly planner: CompensationPlanner,
    private readonly repo: CompensationRepository,
    private readonly locks: InventoryLockService,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
    private readonly bridge: BookingConfirmationBridge,
    private readonly voidExecutor: PaymentVoidExecutor,
  ) {}

  private get autoProviderCancel(): boolean {
    return this.config.get<boolean>('BOOKING_COMPENSATION_AUTO_PROVIDER_CANCEL_ENABLED') === true;
  }
  private get autoVoid(): boolean {
    return this.config.get<boolean>('BOOKING_COMPENSATION_AUTO_VOID_ENABLED') === true;
  }

  get planningEnabled(): boolean {
    return (
      this.config.get<boolean>('BOOKING_COMPENSATION_ENABLED') === true &&
      this.config.get<boolean>('BOOKING_COMPENSATION_PLANNING_ENABLED') === true
    );
  }
  get executionEnabled(): boolean {
    return (
      this.planningEnabled &&
      this.config.get<boolean>('BOOKING_COMPENSATION_EXECUTION_ENABLED') === true
    );
  }

  /**
   * Plan compensation for a discrepancy. Idempotent: re-planning the same discrepancy returns
   * the same durable records. Safe auto-executable actions are promoted PLANNED→READY; money/
   * manual actions stay PLANNED and are marked MANUAL_REVIEW.
   */
  async plan(
    ctx: CompensationContext,
    input: PlanCompensationInput,
  ): Promise<{ classification: string; records: BookingCompensation[] }> {
    const plan = this.planner.plan(ctx);
    this.metrics.recordCompensationPlan(
      plan.classification,
      plan.autoExecutable ? 'auto' : 'review',
    );
    if (!this.planningEnabled || plan.actions.length === 0) {
      return { classification: plan.classification, records: [] };
    }
    const records: BookingCompensation[] = [];
    for (const action of plan.actions) {
      const { compensation, created } = await this.repo.createOrGet(action, input);
      records.push(compensation);
      if (!created) continue; // idempotent replay — never re-promote
      if (
        action.autoExecutable &&
        SAFE_NON_FINANCIAL_ACTIONS.has(action.compensationType) &&
        !FINANCIAL_ACTIONS.has(action.compensationType)
      ) {
        await this.repo.advance(compensation, CompensationState.READY).catch(() => undefined);
      } else {
        // Financial / confirmed-cancel / MANUAL_REVIEW → never auto-ready in P5.3A.
        await this.repo
          .advance(compensation, CompensationState.MANUAL_REVIEW, {
            manualReviewReason: action.reasonCode,
          })
          .catch(() => undefined);
      }
    }
    return { classification: plan.classification, records };
  }

  /**
   * Execute due safe compensations (worker path). Claims with a lease; executes ONLY safe
   * non-financial actions; a financial action that somehow reaches READY is forced to
   * MANUAL_REVIEW. Retries with bounded backoff; dead-letters poison work.
   */
  async processReady(
    workerId = 'compensation-worker',
  ): Promise<{ claimed: number; completed: number }> {
    if (!this.executionEnabled) return { claimed: 0, completed: 0 };
    const lease = this.config.get<number>('BOOKING_COMPENSATION_LEASE_SECONDS') ?? 60;
    await this.repo.recoverStaleLeases();
    const claimed = await this.repo.claimReady(workerId, lease, 50);
    let completed = 0;
    for (const comp of claimed) {
      const type = comp.compensationType as CompensationType;
      // Phase 4 (ADR-043 P5.3B): provider RESERVATION cancellation — unpaid/unconfirmed/
      // idempotent only, gated by its own flag. NOT money movement. Cancels once (the record
      // is lease-claimed by a single worker; the provider call is idempotent).
      if (type === CompensationType.PROVIDER_RESERVATION_CANCEL) {
        if (!this.autoProviderCancel) {
          await this.repo
            .advance(comp, CompensationState.MANUAL_REVIEW, {
              manualReviewReason: 'AUTO_PROVIDER_CANCEL_DISABLED',
            })
            .catch(() => undefined);
          continue;
        }
        try {
          const outcome = await this.bridge.cancelProviderReservation(comp.bookingId);
          if (outcome === 'CANCELLED') {
            await this.repo.advance(comp, CompensationState.COMPLETED, { completedAt: new Date() });
            this.metrics.recordCompensationOperation(type, 'completed');
            completed++;
          } else if (outcome === 'RETRYABLE') {
            await this.repo.scheduleRetryOrDeadLetter(
              comp,
              this.backoff(comp.attemptCount),
              'PROVIDER_CANCEL_RETRYABLE',
            );
            this.metrics.recordCompensationOperation(type, 'retry_or_dead_letter');
          } else {
            await this.repo.advance(comp, CompensationState.MANUAL_REVIEW, {
              manualReviewReason: outcome,
            });
            this.metrics.recordCompensationOperation(type, 'manual_review');
          }
        } catch (err) {
          const code = (err as { code?: string }).code ?? 'UNKNOWN';
          await this.repo.scheduleRetryOrDeadLetter(comp, this.backoff(comp.attemptCount), code);
          this.metrics.recordCompensationOperation(type, 'retry_or_dead_letter');
        }
        continue;
      }
      // Phase 5 (ADR-043 P5.3B): payment VOID — authorized-not-captured only, gated by its own
      // flag. Refunds are NEVER auto-executed here (a captured payment is handed off to a plan).
      if (type === CompensationType.PAYMENT_VOID) {
        if (!this.autoVoid) {
          await this.repo
            .advance(comp, CompensationState.MANUAL_REVIEW, {
              manualReviewReason: 'AUTO_VOID_DISABLED',
            })
            .catch(() => undefined);
          continue;
        }
        try {
          const outcome = await this.voidExecutor.execute(comp);
          if (outcome === 'VOIDED') {
            await this.repo.advance(comp, CompensationState.COMPLETED, { completedAt: new Date() });
            this.metrics.recordCompensationOperation(type, 'completed');
            completed++;
          } else if (outcome === 'RETRYABLE') {
            await this.repo.scheduleRetryOrDeadLetter(
              comp,
              this.backoff(comp.attemptCount),
              'PAYMENT_VOID_RETRYABLE',
            );
            this.metrics.recordCompensationOperation(type, 'retry_or_dead_letter');
          } else if (outcome === 'SUPERSEDED_BY_REFUND') {
            // Captured payment → a refund plan was created; this void is superseded (not executed).
            await this.repo.advance(comp, CompensationState.CANCELLED, {
              manualReviewReason: 'SUPERSEDED_BY_REFUND',
            });
            this.metrics.recordCompensationOperation(type, 'superseded_by_refund');
          } else {
            await this.repo.advance(comp, CompensationState.MANUAL_REVIEW, {
              manualReviewReason: outcome,
            });
            this.metrics.recordCompensationOperation(type, 'manual_review');
          }
        } catch (err) {
          const code = (err as { code?: string }).code ?? 'UNKNOWN';
          await this.repo.scheduleRetryOrDeadLetter(comp, this.backoff(comp.attemptCount), code);
          this.metrics.recordCompensationOperation(type, 'retry_or_dead_letter');
        }
        continue;
      }
      // Money movement (refund) + confirmed-provider-booking cancellation are never auto-executed.
      if (FINANCIAL_ACTIONS.has(type) || !SAFE_NON_FINANCIAL_ACTIONS.has(type)) {
        await this.repo
          .advance(comp, CompensationState.MANUAL_REVIEW, {
            manualReviewReason: 'FINANCIAL_OR_UNSAFE',
          })
          .catch(() => undefined);
        continue;
      }
      try {
        const outcome = await this.executeSafe(comp);
        if (outcome === 'COMPLETED') {
          await this.repo.advance(comp, CompensationState.COMPLETED, { completedAt: new Date() });
          this.metrics.recordCompensationOperation(type, 'completed');
          completed++;
        } else {
          await this.repo.advance(comp, CompensationState.MANUAL_REVIEW, {
            manualReviewReason: outcome,
          });
          this.metrics.recordCompensationOperation(type, 'manual_review');
        }
      } catch (err) {
        const code = (err as { code?: string }).code ?? 'UNKNOWN';
        await this.repo.scheduleRetryOrDeadLetter(comp, this.backoff(comp.attemptCount), code);
        this.metrics.recordCompensationOperation(type, 'retry_or_dead_letter');
      }
    }
    return { claimed: claimed.length, completed };
  }

  /** Execute a single safe action. Returns COMPLETED or a manual-review reason. */
  private async executeSafe(comp: BookingCompensation): Promise<'COMPLETED' | string> {
    switch (comp.compensationType as CompensationType) {
      case CompensationType.REDIS_LOCK_RELEASE: {
        const lockId = comp.targetReference;
        const raw = await this.locks.getRaw(lockId).catch(() => null);
        if (raw) await this.locks.markInternal(raw, 'RELEASED');
        return 'COMPLETED';
      }
      // Hold release / status recovery / local-confirm retry require the booking/orchestrator
      // seams; wired in a follow-up. For now they are surfaced for manual handling rather than
      // silently completed.
      default:
        return 'EXECUTOR_NOT_WIRED';
    }
  }

  private backoff(attempt: number): number {
    const base = this.config.get<number>('BOOKING_COMPENSATION_POLL_INTERVAL_SECONDS') ?? 30;
    return Math.min(base * 2 ** Math.max(0, attempt - 1), 3600);
  }
}
