import { Injectable, Logger } from '@nestjs/common';
import { WebhookProcessingStatus } from '@eticketsgo/shared-types';
import { PrismaService } from '../../../prisma/prisma.service';
import { MetricsService } from '../../../metrics/metrics.service';
import { DeliveryRecorderService } from '../delivery-recorder.service';
import { SuppressionService } from '../suppression.service';
import {
  CORRELATION_WINDOW_MS,
  LEDGER_PREFIX,
  TWILIO_INBOUND,
  applyOptOut,
  isStoredOptOut,
  ledgerKey,
  settleWebhookEvent,
  type StoredOptOutEvent,
  type StoredProviderEvent,
} from './provider-event-ledger';

/**
 * A claimed row that nobody finished is stale after this long. A webhook request does not take
 * ten minutes; a process that died between claiming an event and settling it does.
 */
const STALE_CLAIM_MS = 10 * 60 * 1000;
const SWEEP_BATCH = 200;

export interface ReplaySummary {
  applied: number;
  stillWaiting: number;
  deadLettered: number;
}

interface LedgerRow {
  id: string;
  provider: string;
  processingStatus: string;
  createdAt: Date;
  updatedAt: Date;
  payload: unknown;
}

/**
 * Applying verified callbacks that arrived before the message they describe was recorded.
 *
 * ── THE RACE ───────────────────────────────────────────────────────────────────────
 * The worker calls the provider, gets a message SID back, and THEN writes it to the delivery
 * row. A callback that lands between those two steps finds no delivery carrying that SID. The
 * event was being claimed -- its unique key written, so a redelivery is a duplicate -- and then
 * dropped, which made it unrecoverable: a `failed` or a STOP that arrived early was lost for
 * good, and the message stayed ACCEPTED.
 *
 * ── THE MECHANISM ──────────────────────────────────────────────────────────────────
 * Such an event is settled AWAITING_CORRELATION instead, with everything needed to apply it
 * later kept on the row. It is applied from two places:
 *
 *   - the worker, straight after it records a SID (`reapplyFor`), which covers the usual case
 *     within milliseconds;
 *   - a sweep, which covers the window where both sides looked at the same moment and each
 *     missed the other, and a process that died mid-way. It dead-letters what has not
 *     correlated within the window.
 *
 * Nothing waits inside the HTTP request: the webhook answers the provider at once, as before.
 *
 * ── WHY APPLYING TWICE IS SAFE ─────────────────────────────────────────────────────
 * Each replay first moves the row to PROCESSING with a conditional update, so two replays of
 * one row cannot both proceed. And the recorder only ever moves a delivery forward by rank, so
 * even an event applied by the webhook and then again here changes nothing the second time.
 */
@Injectable()
export class ProviderEventReplayService {
  private readonly logger = new Logger('NotificationWebhook');

  constructor(
    private readonly prisma: PrismaService,
    private readonly recorder: DeliveryRecorderService,
    private readonly metrics?: MetricsService,
    /* Needed to re-apply an opt-out keyword a crashed process claimed but never applied. */
    private readonly suppression?: SuppressionService,
  ) {}

  /** Apply what arrived early for one message, now that its SID is recorded. */
  async reapplyFor(
    provider: string,
    providerMessageId: string | null | undefined,
  ): Promise<number> {
    if (!providerMessageId) return 0;
    const rows = (await this.prisma.webhookEvent.findMany({
      where: {
        provider: ledgerKey(provider),
        processingStatus: WebhookProcessingStatus.AWAITING_CORRELATION,
        payload: { path: ['providerMessageId'], equals: providerMessageId },
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
      select: ROW_SELECT,
    })) as LedgerRow[];

    let applied = 0;
    for (const row of rows) {
      if ((await this.replay(row, new Date())) === 'applied') applied += 1;
    }
    return applied;
  }

  /** The safety net: every waiting event, and any claim a crashed process left behind. */
  async sweep(now: Date = new Date()): Promise<ReplaySummary> {
    const summary: ReplaySummary = { applied: 0, stillWaiting: 0, deadLettered: 0 };
    const rows = (await this.prisma.webhookEvent.findMany({
      where: {
        provider: { startsWith: LEDGER_PREFIX },
        OR: [
          { processingStatus: WebhookProcessingStatus.AWAITING_CORRELATION },
          {
            processingStatus: {
              in: [WebhookProcessingStatus.RECEIVED, WebhookProcessingStatus.PROCESSING],
            },
            updatedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) },
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: SWEEP_BATCH,
      select: ROW_SELECT,
    })) as LedgerRow[];

    for (const row of rows) {
      const result = await this.replay(row, now);
      if (result === 'applied') summary.applied += 1;
      else if (result === 'expired') summary.deadLettered += 1;
      else if (result === 'unknown') summary.stillWaiting += 1;
    }
    return summary;
  }

  private async replay(
    row: LedgerRow,
    now: Date,
  ): Promise<'applied' | 'ignored' | 'unknown' | 'expired' | 'skipped'> {
    const event = row.payload as StoredProviderEvent | null;
    const provider = row.provider.slice(LEDGER_PREFIX.length);

    // Conditional on the status AND the version we read, so a concurrent replay loses cleanly.
    const claim = await this.prisma.webhookEvent.updateMany({
      where: {
        id: row.id,
        processingStatus: row.processingStatus as never,
        updatedAt: row.updatedAt,
      },
      data: { processingStatus: WebhookProcessingStatus.PROCESSING, attempts: { increment: 1 } },
    });
    if (claim.count !== 1) return 'skipped';

    if (isStoredOptOut(row.payload)) return this.replayOptOut(row, row.payload);

    if (!event?.providerMessageId || !event.state) {
      // A row nobody can apply. Dead-lettered rather than retried forever.
      await settleWebhookEvent(this.prisma, row.id, 'expired');
      return 'expired';
    }

    try {
      const outcome = await this.recorder.applyProviderEvent({
        provider,
        providerMessageId: event.providerMessageId,
        state: event.state,
        providerStatus: event.providerStatus,
        failureCode: event.failureCode,
        failureReason: event.failureReason ?? null,
        destinationRef: event.destinationRef ?? null,
        suppressionReason: event.suppressionReason ?? null,
        occurredAt: event.occurredAt ? new Date(event.occurredAt) : undefined,
      });
      const expired = now.getTime() - row.createdAt.getTime() > CORRELATION_WINDOW_MS;
      const settled = outcome === 'unknown' && expired ? 'expired' : outcome;
      await settleWebhookEvent(this.prisma, row.id, settled);
      if (settled === 'applied') this.metrics?.recordNotificationWebhook(provider, 'replayed');
      if (settled === 'expired') this.metrics?.recordNotificationWebhook(provider, 'dead_letter');
      return settled;
    } catch (err) {
      /*
        Put back, never left PROCESSING: the next sweep tries again. Logged by class only --
        the error text can come from anywhere and this line goes to a retained log.
      */
      await this.prisma.webhookEvent
        .update({
          where: { id: row.id },
          data: { processingStatus: WebhookProcessingStatus.AWAITING_CORRELATION },
        })
        .catch(() => undefined);
      this.logger.warn(
        `replay of a ${provider} callback failed (${err instanceof Error ? err.name : 'error'}); will retry`,
      );
      return 'unknown';
    }
  }

  /**
   * An opt-out keyword that was claimed and never applied -- the process died in between.
   *
   * ── WHY IT CHECKS FOR A NEWER KEYWORD FIRST ────────────────────────────────────────
   * Keywords are only meaningful in order. If this stale row is a STOP and the same number has
   * since texted START (which was applied), re-applying the STOP now would suppress somebody
   * who opted back in -- the exact sticky state this webhook exists to prevent. So a keyword is
   * re-applied only when no later keyword for that number has already been processed.
   *
   * Never dead-lettered: a STOP is a legal instruction and has no expiry.
   */
  private async replayOptOut(
    row: LedgerRow,
    event: StoredOptOutEvent,
  ): Promise<'applied' | 'ignored' | 'unknown'> {
    if (!this.suppression) {
      await this.prisma.webhookEvent
        .update({
          where: { id: row.id },
          data: { processingStatus: row.processingStatus as never },
        })
        .catch(() => undefined);
      return 'unknown';
    }
    const hash = event.destinationRef?.hashes?.sms;
    const newer = hash
      ? await this.prisma.webhookEvent.findFirst({
          where: {
            provider: ledgerKey(TWILIO_INBOUND),
            processingStatus: WebhookProcessingStatus.PROCESSED,
            createdAt: { gt: row.createdAt },
            payload: { path: ['destinationRef', 'hashes', 'sms'], equals: hash },
          },
          select: { id: true },
        })
      : null;
    const outcome = newer ? 'ignored' : await applyOptOut(this.suppression, event);
    await settleWebhookEvent(this.prisma, row.id, outcome);
    if (outcome === 'applied') this.metrics?.recordNotificationWebhook(TWILIO_INBOUND, 'replayed');
    return outcome;
  }
}

const ROW_SELECT = {
  id: true,
  provider: true,
  processingStatus: true,
  createdAt: true,
  updatedAt: true,
  payload: true,
} as const;
