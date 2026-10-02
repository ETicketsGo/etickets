import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from '../../metrics/metrics.service';
import { ReconciliationReaderRegistry } from './reconciliation-reader.registry';
import {
  planSweep,
  observeCandidate,
  operatorAttention,
  backoffFor,
  DEFAULT_SWEEP_WINDOWS,
  DEFAULT_SWEEP_LIMITS,
  DEFAULT_ESCALATION,
  type SweepCandidate,
  type SweepReport,
  type AttentionReason,
} from './reversal-sweeper';

/**
 * The scheduled, read-only reversal reconciliation sweep.
 *
 * ── WHAT THIS DOES AND REFUSES TO DO ───────────────────────────────────────────────
 * It finds reversal attempts whose outcome we never learned, asks the provider what it did, and
 * records the answer. It moves no money, and structurally cannot: it is given a
 * `ReconciliationReaderRegistry`, which hands out one-method readers and keeps no reference to
 * the payment registry, so `createTransfer` and friends are not reachable from here at all.
 *
 * ── WHY IT DOES NOT APPLY THE EVIDENCE ITSELF ──────────────────────────────────────
 * It writes only observation bookkeeping - when we last looked, and how many times. Turning
 * evidence into a settlement outcome is `reconcileTransferEvidence`, the one engine every other
 * path already goes through. A sweep with accounting of its own would be a second opinion about
 * money, which is the thing this whole area exists to prevent.
 *
 * ── OFF BY DEFAULT ─────────────────────────────────────────────────────────────────
 * `SETTLEMENT_REVERSAL_RECONCILE_ENABLED` defaults to false. The worker may register the job
 * regardless of the flag - registration is an infrastructure concern - but with the flag off
 * NOTHING queries a provider. Deliberately independent of Route/Connect enablement: reading what
 * a provider did and being allowed to move money are different permissions, and coupling them
 * would mean we could only observe money once we were already moving it.
 */
@Injectable()
export class ReversalReconciliationService {
  private readonly logger = new Logger('ReversalReconcile');

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
    private readonly readers: ReconciliationReaderRegistry,
  ) {}

  /** True only when explicitly switched on. Anything unparseable reads as off. */
  private get enabled(): boolean {
    const raw = this.config.get<string | boolean>('SETTLEMENT_REVERSAL_RECONCILE_ENABLED');
    return raw === true || raw === 'true' || raw === '1';
  }

  /**
   * A positive finite number from configuration, or the default.
   *
   * A malformed interval or batch size must never crash-loop the worker or, worse, read as zero
   * and silently disable the sweep while the flag says it is on. Same guard the other worker
   * intervals use.
   */
  private positive(key: string, fallback: number): number {
    const raw = Number(this.config.get<string>(key));
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  }

  private get limits() {
    return {
      batchSize: this.positive(
        'SETTLEMENT_REVERSAL_RECONCILE_BATCH',
        DEFAULT_SWEEP_LIMITS.batchSize,
      ),
      concurrency: this.positive(
        'SETTLEMENT_REVERSAL_RECONCILE_CONCURRENCY',
        DEFAULT_SWEEP_LIMITS.concurrency,
      ),
    };
  }

  /**
   * One sweep.
   *
   * Returns a report rather than logging and forgetting, so a caller - or a test - can see what
   * happened without inferring it from side effects.
   */
  async sweep(now = new Date()): Promise<SweepReport> {
    const empty: SweepReport = {
      scanned: 0,
      observed: 0,
      reconciled: 0,
      providerUnreachable: 0,
      notDue: 0,
      noReference: 0,
      needsOperatorAttention: [],
    };
    if (!this.enabled) return empty;

    const limits = this.limits;

    /*
      A coarse, indexable pre-filter: unresolved attempts either never looked at, or not looked
      at for at least the SHORTEST rung of the ladder. The exact ladder is then applied in code
      by `isSweepDue`, so the schedule has one definition and the query cannot drift from it.

      Taking more than one batch on purpose - the plan sorts by least-recently-looked and then
      truncates, which it cannot do if the query has already truncated arbitrarily.
    */
    const horizon = new Date(now.getTime() - backoffFor(1));
    const rows = await this.prisma.settlementReversalAttempt.findMany({
      where: {
        status: { in: ['REQUESTED', 'PROCESSING', 'UNKNOWN'] },
        OR: [{ lastReconciledAt: null }, { lastReconciledAt: { lte: horizon } }],
      },
      orderBy: [{ lastReconciledAt: { sort: 'asc', nulls: 'first' } }, { requestedAt: 'asc' }],
      take: Math.min(limits.batchSize * 10, 1000),
      select: {
        id: true,
        settlementId: true,
        provider: true,
        currency: true,
        status: true,
        requestedAt: true,
        lastReconciledAt: true,
        reconcileCount: true,
        settlement: { select: { providerTransferId: true } },
      },
    });

    const candidates: SweepCandidate[] = rows.map((row) => ({
      id: row.id,
      settlementId: row.settlementId,
      provider: row.provider,
      providerTransferId: row.settlement?.providerTransferId ?? null,
      currency: row.currency,
      status: row.status as SweepCandidate['status'],
      requestedAt: row.requestedAt,
      lastReconciledAt: row.lastReconciledAt,
      reconcileCount: row.reconcileCount,
    }));

    const report: SweepReport = { ...empty, scanned: candidates.length };

    /*
      Operator attention is computed over EVERY unresolved attempt scanned, not only the ones
      this sweep looks at. A row that is not due is still a row somebody may need to chase, and
      reporting attention only for rows we happened to query would hide the worst cases - the
      ones so far up the ladder they are rarely due.
    */
    const escalateAfterMs = this.positive(
      'SETTLEMENT_REVERSAL_ESCALATE_AFTER_MS',
      DEFAULT_ESCALATION.afterMs,
    );
    for (const candidate of candidates) {
      const reasons: AttentionReason[] = operatorAttention(candidate, now, {
        afterMs: escalateAfterMs,
      });
      if (reasons.length > 0) {
        report.needsOperatorAttention.push({ attemptId: candidate.id, reasons });
        this.metrics.recordReversalReconcile(candidate.provider, 'attention');
      }
    }

    const plan = planSweep(candidates, now, DEFAULT_SWEEP_WINDOWS, limits);
    report.observed = plan.length;

    // Bounded concurrency: a fixed pool of workers pulling from one cursor.
    let next = 0;
    const lanes = Array.from({ length: Math.min(limits.concurrency, plan.length) }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= plan.length) return;
        await this.observeOne(plan[index], now, report);
      }
    });
    await Promise.all(lanes);

    if (report.observed > 0 || report.needsOperatorAttention.length > 0) {
      this.logger.log(
        `swept ${report.observed}/${report.scanned} reconciled=${report.reconciled} ` +
          `unreachable=${report.providerUnreachable} attention=${report.needsOperatorAttention.length}`,
      );
    }
    return report;
  }

  private async observeOne(
    candidate: SweepCandidate,
    now: Date,
    report: SweepReport,
  ): Promise<void> {
    const reader = this.readers.for(candidate.provider);
    if (reader === null) {
      /*
        The provider cannot be read at all - not configured in this process, or an adapter with
        no reversal lookup. That is not evidence about the money, so nothing is written and the
        ladder does not advance: advancing it would slow down re-checks for a row we never
        actually asked about.
      */
      report.noReference += 1;
      this.metrics.recordReversalReconcile(candidate.provider, 'no_reference');
      return;
    }

    const outcome = await observeCandidate(candidate, reader, now);

    switch (outcome.kind) {
      case 'RECONCILED': {
        /*
          The provider answered. The ANSWER is not applied here - that is
          `reconcileTransferEvidence`, which every other path also goes through. What is recorded
          is only that we looked, and the evidence, so the engine can be run over it without
          asking the provider again.
        */
        report.reconciled += 1;
        this.metrics.recordReversalReconcile(candidate.provider, 'reconciled');
        await this.prisma.settlementReversalAttempt.update({
          where: { id: candidate.id },
          data: {
            lastReconciledAt: now,
            reconcileCount: { increment: 1 },
            evidence: JSON.parse(JSON.stringify(outcome.evidence)),
          },
        });
        return;
      }
      case 'PROVIDER_UNREACHABLE': {
        /*
          "We could not ask" is not "nothing happened". The attempt's financial state is
          untouched; only the ladder moves, so a provider outage backs off instead of hammering.
        */
        report.providerUnreachable += 1;
        this.metrics.recordReversalReconcile(candidate.provider, 'unreachable');
        await this.prisma.settlementReversalAttempt.update({
          where: { id: candidate.id },
          data: {
            lastReconciledAt: now,
            reconcileCount: { increment: 1 },
            lastError: outcome.error,
          },
        });
        return;
      }
      case 'NOT_DUE':
        report.notDue += 1;
        this.metrics.recordReversalReconcile(candidate.provider, 'not_due');
        return;
      case 'NO_REFERENCE':
        report.noReference += 1;
        this.metrics.recordReversalReconcile(candidate.provider, 'no_reference');
        return;
    }
  }
}
