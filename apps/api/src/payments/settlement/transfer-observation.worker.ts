import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransferReconciliationService } from './transfer-reconciliation.service';
import { TransferReaderRegistry } from './transfer-reader.registry';

/**
 * Asking providers what became of transfers whose outcome we never learned.
 *
 * ── THE ONE RULE, AND HOW IT IS ENFORCED ───────────────────────────────────────────────
 * Provider OBSERVATION may be automated. Provider MONEY MOVEMENT may not.
 *
 *   UNKNOWN -> QUERY -> authoritative evidence -> classify -> record
 *
 * never
 *
 *   UNKNOWN -> send the transfer again
 *
 * This is the same rule the reversal sweeper follows, and it is enforced the same way: by what
 * this worker is given rather than by what it remembers not to do. Its only provider-shaped
 * dependency is a `ProviderTransferReader` - an interface with exactly one method, which reads.
 * It never receives an adapter that can create a transfer, issue a reversal or refund anything,
 * so the capability is ABSENT rather than merely unused.
 *
 * A test can show a thing was not done. A narrower type means it could not be.
 *
 * ── IT IS OFF ──────────────────────────────────────────────────────────────────────────
 * `TRANSFER_OBSERVATION_ENABLED` defaults to false and `sweep()` returns an empty result when
 * disabled. Nothing schedules it. It is named for what it does - observation - so that enabling
 * it can never be mistaken for enabling payouts.
 *
 * ── AND TODAY IT WOULD FIND NOTHING TO ASK ─────────────────────────────────────────────
 * No adapter implements `getTransferState`, so `readerFor()` returns null for every provider and
 * each attempt is recorded as CANNOT_BE_ASKED. That is the honest outcome, and it is also why
 * there is no backoff ladder here yet: a provider that cannot be asked is not asked again on a
 * timer, it is left for a person. Backoff becomes necessary when a real reader exists, and the
 * reversal sweeper's `SweepWindows` is the shape to copy when it does.
 */
@Injectable()
export class TransferObservationWorker {
  private readonly logger = new Logger(TransferObservationWorker.name);

  constructor(
    private readonly reconciliation: TransferReconciliationService,
    private readonly config: ConfigService,
    /**
     * Where a READER comes from, if one exists for this provider.
     *
     * Deliberately not `PaymentProviderRegistry`. That one can move money, and a worker holding
     * it would be one `.createTransfer(` away from paying an organizer twice on the strength of
     * a guess. The registry narrows it and keeps no reachable reference to the full adapter.
     */
    private readonly readers: TransferReaderRegistry,
  ) {}

  private get enabled(): boolean {
    const raw = this.config.get<string | boolean>('TRANSFER_OBSERVATION_ENABLED');
    return raw === true || raw === 'true';
  }

  /**
   * One pass: find unresolved attempts, ask where we can, record what we learn.
   *
   * Bounded by `limit` so a pass cannot grow with the backlog, and it reports what it did rather
   * than logging into the void.
   */
  async sweep(limit = 25): Promise<{
    enabled: boolean;
    examined: number;
    asked: number;
    couldNotAsk: number;
    resolved: number;
    findings: number;
  }> {
    const empty = {
      enabled: false,
      examined: 0,
      asked: 0,
      couldNotAsk: 0,
      resolved: 0,
      findings: 0,
    };
    if (!this.enabled) return empty;

    const attempts = await this.reconciliation.unresolvedAttempts(limit);
    let asked = 0;
    let couldNotAsk = 0;
    let resolved = 0;
    let findings = 0;

    for (const a of attempts) {
      const reader = this.readers.for(a.provider);
      if (reader) asked += 1;
      else couldNotAsk += 1;

      const outcome = await this.reconciliation.reconcileOne(
        {
          attemptId: a.id,
          settlementId: a.settlementId,
          organizationId: a.settlement.organizationId,
          status: a.status as 'REQUESTED' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN',
          requestedMinor: a.requestedMinor,
          currency: a.currency,
          providerTransferId: a.providerTransferId,
          idempotencyKey: a.idempotencyKey,
          destinationAccountId: a.destinationAccountId,
        },
        reader,
      );

      if (outcome.kind === 'RESOLVED') resolved += 1;
      if (outcome.kind === 'FINDING') findings += 1;
    }

    this.logger.log(
      `observed ${attempts.length} unresolved transfer(s): asked=${asked} couldNotAsk=${couldNotAsk} resolved=${resolved} findings=${findings}`,
    );

    return {
      enabled: true,
      examined: attempts.length,
      asked,
      couldNotAsk,
      resolved,
      findings,
    };
  }
}
