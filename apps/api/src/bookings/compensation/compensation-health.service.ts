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
      healthy,
    };
  }
}
