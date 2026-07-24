import { Injectable, Logger } from '@nestjs/common';
import { WebhookProcessingStatus } from '@eticketsgo/shared-types';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { PaymentsService } from '../../payments.service';
import { OrganizerConnectService } from '../../connect/organizer-connect.service';
import type { PaymentEvent } from '../../provider/payment-provider.interface';

/** Max processing attempts before an event is dead-lettered for ops review. */
const MAX_ATTEMPTS = 6;
/** Backoff before a FAILED event is retried by the sweep (ms). */
const RETRY_BACKOFF_MS = 30_000;

// ─── Minimal shapes of the Stripe objects we read (avoids importing SDK types here) ───
interface SessionLike {
  metadata?: Record<string, string> | null;
  client_reference_id?: string | null;
  amount_total?: number | null;
  payment_intent?: string | { id: string } | null;
}
interface PaymentIntentLike {
  id: string;
  metadata?: Record<string, string> | null;
  amount_received?: number | null;
  amount?: number | null;
}
interface AccountLike {
  id: string;
  details_submitted?: boolean;
  charges_enabled?: boolean;
  payouts_enabled?: boolean;
  requirements?: { currently_due?: string[] | null; disabled_reason?: string | null } | null;
  default_currency?: string | null;
  country?: string | null;
}
interface StoredPayload {
  account?: string | null;
  object: unknown;
}

type DispatchResult = 'processed' | 'ignored';

/**
 * Processes durably-accepted Stripe webhook events (the WebhookEvent store). Idempotent:
 * an atomic RECEIVED/FAILED → PROCESSING claim ensures a single worker handles each event,
 * and every downstream action (ticket issuance, refund/dispute/settlement sync) is itself
 * idempotent. Failures retry with backoff and dead-letter after MAX_ATTEMPTS.
 *
 * The dispatch switch is extended by later milestones (refunds/disputes → M6,
 * transfers/payouts → M5); events without a handler are recorded as IGNORED (received,
 * no action taken), never silently dropped.
 */
@Injectable()
export class StripeWebhookProcessor {
  private readonly logger = new Logger(StripeWebhookProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly connect: OrganizerConnectService,
    private readonly audit: AuditService,
  ) {}

  /** Process one webhook event by id (best-effort fast path + the sweep both call this). */
  async process(webhookEventId: string): Promise<void> {
    // Atomic claim: only the caller that flips RECEIVED/FAILED → PROCESSING proceeds.
    const claim = await this.prisma.webhookEvent.updateMany({
      where: {
        id: webhookEventId,
        processingStatus: {
          in: [WebhookProcessingStatus.RECEIVED, WebhookProcessingStatus.FAILED],
        },
      },
      data: { processingStatus: WebhookProcessingStatus.PROCESSING, attempts: { increment: 1 } },
    });
    if (claim.count !== 1) return; // already processing / processed / dead-lettered

    const record = await this.prisma.webhookEvent.findUnique({ where: { id: webhookEventId } });
    if (!record) return;

    try {
      const result = await this.dispatch(
        record.eventType,
        record.payload as unknown as StoredPayload,
      );
      await this.prisma.webhookEvent.update({
        where: { id: webhookEventId },
        data: {
          processingStatus:
            result === 'processed'
              ? WebhookProcessingStatus.PROCESSED
              : WebhookProcessingStatus.IGNORED,
          processedAt: new Date(),
          errorMessage: null,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = record.attempts;
      const dead = attempts >= MAX_ATTEMPTS;
      await this.prisma.webhookEvent.update({
        where: { id: webhookEventId },
        data: {
          processingStatus: dead
            ? WebhookProcessingStatus.DEAD_LETTER
            : WebhookProcessingStatus.FAILED,
          errorMessage: message.slice(0, 500),
        },
      });
      if (dead) {
        this.logger.error(
          `Stripe webhook ${record.providerEventId} (${record.eventType}) dead-lettered after ${attempts} attempts: ${message}`,
        );
        await this.audit.record({
          action: 'WEBHOOK_DEAD_LETTER',
          entityType: 'WebhookEvent',
          entityId: webhookEventId,
          metadata: { eventType: record.eventType, providerEventId: record.providerEventId },
        });
      } else {
        this.logger.warn(
          `Stripe webhook ${record.providerEventId} (${record.eventType}) failed (attempt ${attempts}): ${message}`,
        );
      }
    }
  }

  /** Sweep due events (RECEIVED, or FAILED past the backoff and under the attempt cap). */
  async processPending(limit = 50): Promise<{ processed: number }> {
    const backoffCutoff = new Date(Date.now() - RETRY_BACKOFF_MS);
    const due = await this.prisma.webhookEvent.findMany({
      where: {
        provider: 'stripe',
        OR: [
          { processingStatus: WebhookProcessingStatus.RECEIVED },
          {
            processingStatus: WebhookProcessingStatus.FAILED,
            attempts: { lt: MAX_ATTEMPTS },
            updatedAt: { lt: backoffCutoff },
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    for (const e of due) await this.process(e.id);
    return { processed: due.length };
  }

  // ─── Dispatch ───

  private async dispatch(eventType: string, payload: StoredPayload): Promise<DispatchResult> {
    switch (eventType) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        return this.handlePayment(
          this.fromSession(payload.object as SessionLike, 'payment.succeeded'),
        );
      case 'checkout.session.async_payment_failed':
        return this.handlePayment(
          this.fromSession(payload.object as SessionLike, 'payment.failed'),
        );
      case 'payment_intent.succeeded':
        return this.handlePayment(
          this.fromPaymentIntent(payload.object as PaymentIntentLike, 'payment.succeeded'),
        );
      case 'payment_intent.payment_failed':
      case 'payment_intent.canceled':
        return this.handlePayment(
          this.fromPaymentIntent(payload.object as PaymentIntentLike, 'payment.failed'),
        );
      case 'account.updated':
        return this.handleAccountUpdated(payload.object as AccountLike);
      default:
        // Received but not acted upon (handlers added in later milestones). Recorded
        // as IGNORED so ops can see exactly which event types are inert.
        return 'ignored';
    }
  }

  private async handlePayment(event: PaymentEvent | null): Promise<DispatchResult> {
    if (!event) return 'ignored';
    await this.payments.processVerifiedEvent(event);
    return 'processed';
  }

  private async handleAccountUpdated(account: AccountLike): Promise<DispatchResult> {
    const synced = await this.connect.syncByProviderAccountId(account.id, {
      accountId: account.id,
      detailsSubmitted: account.details_submitted ?? false,
      chargesEnabled: account.charges_enabled ?? false,
      payoutsEnabled: account.payouts_enabled ?? false,
      requirementsCurrentlyDue: account.requirements?.currently_due ?? [],
      disabledReason: account.requirements?.disabled_reason ?? null,
      defaultCurrency: account.default_currency ?? null,
      country: account.country ?? null,
    });
    return synced ? 'processed' : 'ignored';
  }

  private fromSession(session: SessionLike, type: PaymentEvent['type']): PaymentEvent | null {
    const bookingId = session.metadata?.bookingId ?? session.client_reference_id ?? undefined;
    const amountMinor = session.amount_total;
    if (!bookingId || typeof amountMinor !== 'number') return null;
    const providerRef =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : (session.payment_intent?.id ?? '');
    return { type, providerRef, bookingId, amountMinor };
  }

  private fromPaymentIntent(
    pi: PaymentIntentLike,
    type: PaymentEvent['type'],
  ): PaymentEvent | null {
    const bookingId = pi.metadata?.bookingId;
    const amountMinor = pi.amount_received || pi.amount;
    if (!bookingId || typeof amountMinor !== 'number') return null;
    return { type, providerRef: pi.id, bookingId, amountMinor };
  }
}
