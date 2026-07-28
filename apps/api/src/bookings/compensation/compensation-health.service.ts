import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from '../../metrics/metrics.service';
import { CompensationState } from './compensation-state';

/**
 * Compensation operational health (ADR-043 §26, P5.3A). Bounded COUNTS only — never ids or
 * PII. Doubles as the operator safety net: backlog by state, oldest-ready age, stale leases,
 * last successful safe compensation, plus the provider-pending / status-recovery / allocation-
 * drift backlogs that indicate whether recovery is keeping up. Also publishes bounded gauges.
 */
@Injectable()
export class CompensationHealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
  ) {}

  async snapshot(now = new Date()): Promise<Record<string, unknown>> {
    const planningEnabled =
      this.config.get<boolean>('BOOKING_COMPENSATION_ENABLED') === true &&
      this.config.get<boolean>('BOOKING_COMPENSATION_PLANNING_ENABLED') === true;
    const executionEnabled =
      planningEnabled &&
      this.config.get<boolean>('BOOKING_COMPENSATION_EXECUTION_ENABLED') === true;

    const grouped = await this.prisma.bookingCompensation
      .groupBy({ by: ['state'], _count: { _all: true } })
      .catch(() => [] as Array<{ state: string; _count: { _all: number } }>);
    const counts: Record<string, number> = {};
    for (const s of Object.values(CompensationState)) counts[s] = 0;
    for (const g of grouped) counts[g.state as string] = g._count._all;
    for (const [state, n] of Object.entries(counts)) this.metrics.setCompensationBacklog(state, n);

    const [
      oldestReady,
      staleLeases,
      lastCompleted,
      providerPending,
      statusRecovery,
      allocationDrift,
    ] = await Promise.all([
      this.prisma.bookingCompensation
        .aggregate({
          where: { state: CompensationState.READY as never },
          _min: { availableAt: true },
        })
        .then((r) => r._min.availableAt)
        .catch(() => null),
      this.prisma.bookingCompensation
        .count({
          where: { state: CompensationState.PROCESSING as never, lockExpiresAt: { lt: now } },
        })
        .catch(() => -1),
      this.prisma.bookingCompensation
        .aggregate({
          where: { state: CompensationState.COMPLETED as never },
          _max: { completedAt: true },
        })
        .then((r) => r._max.completedAt)
        .catch(() => null),
      // Provider-pending: payment done, provider not yet confirmed.
      this.prisma.bookingWorkflow
        .count({ where: { state: 'PROVIDER_CONFIRM_PENDING' as never } })
        .catch(() => -1),
      // Status-recovery backlog: workflows flagged for reconciliation.
      this.prisma.bookingWorkflow
        .count({ where: { providerReconciliationRequired: true } })
        .catch(() => -1),
      // Allocation drift: consumption exceeding capacity (authoritative accounting breach).
      this.prisma.$queryRaw<Array<{ n: bigint }>>`
            SELECT COUNT(*)::bigint AS n FROM "ProviderInventoryState"
            WHERE "providerCapacity" IS NOT NULL
              AND "heldLocal" + "confirmedLocal" > "providerCapacity"`
        .then((rows) => Number(rows[0]?.n ?? 0))
        .catch(() => -1),
    ]);

    const oldestReadyAgeSeconds = oldestReady
      ? Math.max(0, Math.round((now.getTime() - oldestReady.getTime()) / 1000))
      : 0;
    this.metrics.setCompensationOldestReadyAge(oldestReadyAgeSeconds);

    // Payment-void-specific backlog (ADR-043 Phase 5) + refund backlog by state (Phase 6).
    const [voidGrouped, refundPlanBacklog, refundGrouped] = await Promise.all([
      this.prisma.bookingCompensation
        .groupBy({
          by: ['state'],
          where: { compensationType: 'PAYMENT_VOID' as never },
          _count: { _all: true },
        })
        .catch(() => [] as Array<{ state: string; _count: { _all: number } }>),
      this.prisma.bookingCompensation
        .count({
          where: {
            compensationType: 'PAYMENT_REFUND' as never,
            state: { in: ['PLANNED', 'READY', 'MANUAL_REVIEW'] as never },
          },
        })
        .catch(() => -1),
      this.prisma.bookingCompensation
        .groupBy({
          by: ['state'],
          where: { compensationType: 'PAYMENT_REFUND' as never },
          _count: { _all: true },
        })
        .catch(() => [] as Array<{ state: string; _count: { _all: number } }>),
    ]);
    const voidCounts: Record<string, number> = {};
    for (const g of voidGrouped) voidCounts[g.state as string] = g._count._all;
    const refundCounts: Record<string, number> = {};
    for (const g of refundGrouped) refundCounts[g.state as string] = g._count._all;
    const voidPlanningEnabled =
      planningEnabled &&
      this.config.get<boolean>('BOOKING_COMPENSATION_AUTO_VOID_ENABLED') === true;
    const voidCapableProvider = this.config.get<string>('PAYMENT_PROVIDER_NAME') === 'mock';
    // Refund is auto-executable only with AUTO_REFUND on, an approved (non-MANUAL_ONLY) policy,
    // and an idempotent-full-refund-capable provider (the mock today). Otherwise → manual review.
    const refundPolicyMode = this.config.get<string>('BOOKING_REFUND_POLICY_MODE') ?? 'MANUAL_ONLY';
    const refundAutoEnabled =
      planningEnabled &&
      this.config.get<boolean>('BOOKING_COMPENSATION_AUTO_REFUND_ENABLED') === true &&
      refundPolicyMode !== 'MANUAL_ONLY';
    const refundCapableProvider = this.config.get<string>('PAYMENT_PROVIDER_NAME') === 'mock';

    const deadLetters = counts[CompensationState.DEAD_LETTERED] ?? 0;
    const manualReview = counts[CompensationState.MANUAL_REVIEW] ?? 0;
    // Healthy unless money-moving backlogs are piling up or accounting drift is detected.
    const healthy = deadLetters === 0 && allocationDrift <= 0 && staleLeases <= 0;

    return {
      mode: { planning: planningEnabled, execution: executionEnabled },
      counts: {
        planned: counts[CompensationState.PLANNED],
        ready: counts[CompensationState.READY],
        processing: counts[CompensationState.PROCESSING],
        retryableFailure: counts[CompensationState.RETRYABLE_FAILURE],
        deadLettered: deadLetters,
        manualReview,
        completed: counts[CompensationState.COMPLETED],
      },
      oldestReadyAgeSeconds,
      staleLeaseCount: staleLeases,
      lastSuccessfulSafeCompensationAt: lastCompleted ?? null,
      providerPendingBacklog: providerPending,
      statusRecoveryBacklog: statusRecovery,
      allocationDriftCount: allocationDrift,
      // Payment void (ADR-043 Phase 5) — counts only, no ids/PII.
      void: {
        planningEnabled: voidPlanningEnabled,
        executionEnabled: voidPlanningEnabled,
        voidCapableProvider,
        ready: voidCounts[CompensationState.READY] ?? 0,
        processing: voidCounts[CompensationState.PROCESSING] ?? 0,
        retryable: voidCounts[CompensationState.RETRYABLE_FAILURE] ?? 0,
        manualReview: voidCounts[CompensationState.MANUAL_REVIEW] ?? 0,
        deadLettered: voidCounts[CompensationState.DEAD_LETTERED] ?? 0,
        capturedRefundPlanBacklog: refundPlanBacklog,
      },
      // Controlled refund (ADR-043 Phase 6) — counts only, no ids/PII.
      refund: {
        autoEnabled: refundAutoEnabled,
        policyMode: refundPolicyMode,
        refundCapableProvider,
        planned: refundCounts[CompensationState.PLANNED] ?? 0,
        ready: refundCounts[CompensationState.READY] ?? 0,
        processing: refundCounts[CompensationState.PROCESSING] ?? 0,
        retryable: refundCounts[CompensationState.RETRYABLE_FAILURE] ?? 0,
        manualReview: refundCounts[CompensationState.MANUAL_REVIEW] ?? 0,
        deadLettered: refundCounts[CompensationState.DEAD_LETTERED] ?? 0,
        completed: refundCounts[CompensationState.COMPLETED] ?? 0,
      },
      healthy,
    };
  }
}
