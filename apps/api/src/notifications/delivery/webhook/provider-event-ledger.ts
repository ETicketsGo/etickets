import {
  SuppressionReason,
  WebhookProcessingStatus,
  type DeliveryState,
} from '@eticketsgo/shared-types';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { DestinationRef, SuppressionService } from '../suppression.service';

/**
 * The ledger of verified delivery callbacks, and the one way a row in it is settled.
 *
 * ── WHY SETTLING IS SHARED ─────────────────────────────────────────────────────────
 * Rows were claimed under `notification:<provider>` and then marked processed under plain
 * `<provider>`. The update matched nothing, so every notification callback ever received
 * stayed RECEIVED, and a callback for an unknown message was never dead-lettered. Settling by
 * the row's id -- the id the claim itself produced -- cannot drift from the claim, and both the
 * webhook and the replay use this function so they cannot drift from each other either.
 */

/** Notification callbacks share `WebhookEvent` with payments; this prefix keeps them apart. */
export const LEDGER_PREFIX = 'notification:';

export function ledgerKey(provider: string): string {
  return `${LEDGER_PREFIX}${provider}`;
}

/**
 * How long a verified callback waits for its message to be correlated.
 *
 * The provider reference is written moments after the provider accepts the send, so any
 * legitimate early callback correlates within seconds. An hour is generous for a slow worker
 * or a database blip; past it, the send almost certainly crashed before its reference was
 * recorded, or the message belongs to another environment sharing the provider account.
 */
export const CORRELATION_WINDOW_MS = 60 * 60 * 1000;

/**
 * What a callback is kept as. Enough to apply it later; nothing about the person beyond a
 * hash and a mask, because this table is long-lived and included in every backup.
 */
export interface StoredProviderEvent {
  providerMessageId: string;
  state: DeliveryState;
  providerStatus: string | null;
  failureCode: string | null;
  /** Sanitized: provider prose can name the recipient. */
  failureReason?: string | null;
  suppressionReason?: SuppressionReason | null;
  destinationRef?: DestinationRef | null;
  occurredAt?: string | null;
}

/** The ledger name for Twilio inbound opt-out keywords, kept apart from status callbacks. */
export const TWILIO_INBOUND = 'twilio-inbound';

/**
 * An opt-out keyword, as the ledger keeps it: what Twilio decided, and the sender as a hash.
 * Never the number and never what they wrote.
 */
export interface StoredOptOutEvent {
  kind: 'opt_out';
  optOutType: 'STOP' | 'START' | 'HELP';
  destinationRef: DestinationRef;
}

export function isStoredOptOut(payload: unknown): payload is StoredOptOutEvent {
  return (payload as { kind?: unknown } | null)?.kind === 'opt_out';
}

/**
 * Make local suppression agree with what Twilio just enforced.
 *
 * STOP suppresses the number as UNSUBSCRIBED -- and re-arms a lifted row, so a second STOP is
 * never lost. START lifts ONLY that reason: a hard failure or a carrier block is not something
 * a customer can undo by texting a keyword. HELP changes nothing; Twilio has already answered.
 */
export async function applyOptOut(
  suppression: Pick<SuppressionService, 'suppress' | 'liftProviderOptOut'>,
  event: StoredOptOutEvent,
): Promise<'applied' | 'ignored'> {
  switch (event.optOutType) {
    case 'STOP':
      await suppression.suppress({
        channel: 'sms',
        destinationRef: event.destinationRef,
        reason: SuppressionReason.UNSUBSCRIBED,
        provider: 'twilio',
      });
      return 'applied';
    case 'START':
      return (await suppression.liftProviderOptOut('sms', event.destinationRef, 'twilio', 'start'))
        ? 'applied'
        : 'ignored';
    default:
      return 'ignored';
  }
}

export type SettleOutcome = 'applied' | 'ignored' | 'unknown' | 'expired';

export async function settleWebhookEvent(
  prisma: Pick<PrismaService, 'webhookEvent'>,
  id: string,
  outcome: SettleOutcome,
): Promise<void> {
  const now = new Date();
  const data =
    outcome === 'unknown'
      ? {
          processingStatus: WebhookProcessingStatus.AWAITING_CORRELATION,
          errorMessage: 'awaiting correlation: no delivery attempt carries this message id yet',
        }
      : outcome === 'expired'
        ? {
            processingStatus: WebhookProcessingStatus.DEAD_LETTER,
            processedAt: now,
            errorMessage:
              'no delivery attempt carried this message id within the correlation window',
          }
        : {
            processingStatus: WebhookProcessingStatus.PROCESSED,
            processedAt: now,
            errorMessage: null,
          };
  await prisma.webhookEvent.update({ where: { id }, data });
}
