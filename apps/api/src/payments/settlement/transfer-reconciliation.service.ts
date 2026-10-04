import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  reconcileTransferAttempt,
  type LocalTransferFacts,
  type ProviderTransferReader,
  type TransferReconciliationOutcome,
} from './transfer-reconciliation';

/**
 * Persisting what reconciliation concluded, and nothing else.
 *
 * ── WHAT THIS SERVICE IS NOT GIVEN ─────────────────────────────────────────────────────
 * Prisma, and a reader that can only read. It has no payment provider, no settlement service,
 * no way to create a transfer or a reversal. That is deliberate and structural: detection and
 * repair are separate privileges, and a detector that could also correct what it found could
 * make a disagreement disappear by rewriting one side of it.
 *
 * It writes exactly one table - `SettlementReconciliationFinding` - and never touches
 * `Settlement`, `SettlementTransferAttempt` money columns, payouts, or anything an organizer is
 * owed. A `RESOLVED` conclusion is RECORDED, not applied; applying it to the money is a separate
 * explicit step that nothing here performs.
 *
 * ── ONE DISAGREEMENT IS ONE ROW ────────────────────────────────────────────────────────
 * Reconciliation is meant to run repeatedly. A worker that opened a new finding on every pass
 * would bury a queue of real problems under copies of one, so `(transferAttemptId, kind)` is
 * unique and a repeat observation advances `lastSeenAt` and `observationCount` instead.
 */
@Injectable()
export class TransferReconciliationService {
  private readonly logger = new Logger(TransferReconciliationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** The attempts whose outcome was never established, oldest first. */
  async unresolvedAttempts(limit = 50, organizationId?: string) {
    return this.prisma.settlementTransferAttempt.findMany({
      where: {
        status: { in: ['UNKNOWN', 'REQUESTED'] },
        ...(organizationId ? { settlement: { organizationId } } : {}),
      },
      orderBy: { requestedAt: 'asc' },
      take: Math.min(Math.max(limit, 1), 200),
      select: {
        id: true,
        settlementId: true,
        status: true,
        requestedMinor: true,
        currency: true,
        provider: true,
        providerTransferId: true,
        idempotencyKey: true,
        destinationAccountId: true,
        requestedAt: true,
        settlement: { select: { organizationId: true } },
      },
    });
  }

  /**
   * Ask about one attempt and record what came back.
   *
   * `reader` is null where the provider cannot be asked at all, which is a conclusion in its own
   * right rather than a reason to skip the attempt quietly.
   */
  async reconcileOne(
    local: LocalTransferFacts,
    reader: ProviderTransferReader | null,
  ): Promise<TransferReconciliationOutcome> {
    const outcome = await reconcileTransferAttempt(local, reader);

    if (outcome.kind === 'FINDING') {
      await this.recordFinding(local, outcome);
      return outcome;
    }

    if (outcome.kind === 'RESOLVED') {
      /*
        The provider gave a conclusion. It is NOT applied to the money here: this service has no
        means to, and deciding that a settlement is now paid or now failed is a financial
        transition with its own rules and its own authority.

        Any finding previously raised for this attempt is closed, because the question it
        described has been answered - but the row is kept, since it is the only record that the
        disagreement ever existed.
      */
      await this.prisma.settlementReconciliationFinding.updateMany({
        where: { transferAttemptId: local.attemptId, status: 'OPEN' },
        data: {
          status: 'RESOLVED',
          resolvedAt: new Date(),
          resolutionNote: outcome.reason.slice(0, 500),
        },
      });
      this.logger.log(
        `transfer ${local.attemptId}: provider says ${outcome.disposition}; recorded, not applied`,
      );
    }

    return outcome;
  }

  /** Upsert on the finding's stable identity, so repeated passes do not multiply it. */
  private async recordFinding(
    local: LocalTransferFacts,
    outcome: Extract<TransferReconciliationOutcome, { kind: 'FINDING' }>,
  ): Promise<void> {
    const provider = outcome.state;
    const now = new Date();

    await this.prisma.settlementReconciliationFinding.upsert({
      where: {
        transferAttemptId_kind: { transferAttemptId: local.attemptId, kind: outcome.finding },
      },
      create: {
        settlementId: local.settlementId,
        organizationId: local.organizationId,
        transferAttemptId: local.attemptId,
        kind: outcome.finding,
        localStatus: local.status,
        localAmountMinor: local.requestedMinor,
        localCurrency: local.currency,
        providerDisposition: provider?.disposition ?? null,
        providerAmountMinor: provider?.amountMinor ?? null,
        providerCurrency: provider?.currency ?? null,
        providerStatusRaw: provider?.providerStatusRaw ?? null,
        detail: outcome.detail.slice(0, 500),
      },
      update: {
        /*
          Seen again. The DISCOVERY time is never moved - how long a disagreement has gone
          unresolved is the thing an operator most needs, and overwriting it would reset the
          clock on every pass and make an old problem look new.
        */
        lastSeenAt: now,
        observationCount: { increment: 1 },
        status: 'OPEN',
        providerDisposition: provider?.disposition ?? null,
        providerAmountMinor: provider?.amountMinor ?? null,
        providerCurrency: provider?.currency ?? null,
        providerStatusRaw: provider?.providerStatusRaw ?? null,
        detail: outcome.detail.slice(0, 500),
      },
    });
  }
}
