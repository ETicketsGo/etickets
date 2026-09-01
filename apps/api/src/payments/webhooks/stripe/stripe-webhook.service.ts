import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { WebhookProcessingStatus } from '@eticketsgo/shared-types';
import { PrismaService } from '../../../prisma/prisma.service';
import { MetricsService } from '../../../metrics/metrics.service';
import { AppException, ErrorCodes } from '../../../common/errors';
import { type WebhookEnvelope } from '../../provider/payment-provider.interface';
import { PaymentProviderResolver } from '../../provider/payment-provider.resolver';
import { StripeWebhookProcessor } from './stripe-webhook.processor';

export interface WebhookIngestResult {
  received: true;
  duplicate: boolean;
}

/**
 * Durable, idempotent Stripe webhook ingestion. Verifies the signature against the
 * RAW body, persists the event keyed on Stripe's event id (so re-delivery is a no-op),
 * then returns a fast 2xx. Processing happens asynchronously — best-effort inline for
 * low latency, with the worker sweep (processPending) as the retry/dead-letter safety net.
 */
@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);
  private readonly provider = 'stripe';

  constructor(
    private readonly prisma: PrismaService,
    /*
      The STRIPE adapter, resolved on demand — not whichever provider happens to be the
      globally configured one.

      This injected `PAYMENT_PROVIDER`, which is `mock` unless somebody sets the global
      switch. So with Stripe keys correctly configured and a Stripe-signed event arriving
      at the Stripe endpoint, this answered `501 The active provider does not support
      Stripe webhooks` — every delivery failed, and the message pointed at a provider the
      caller never asked for.

      That is not a hypothetical: routing is PER BOOKING, from the booking's currency
      (USD → Stripe, INR → Razorpay). There is no single "active provider" for a
      multi-market platform, so a webhook endpoint must resolve the provider it is NAMED
      for. The Razorpay endpoint has always done this; the Stripe one was left behind, and
      the gap was invisible until Stripe keys existed to expose it.
    */
    private readonly resolver: PaymentProviderResolver,
    private readonly processor: StripeWebhookProcessor,
    private readonly metrics: MetricsService,
  ) {}

  async ingest(rawBody: string, signature: string): Promise<WebhookIngestResult> {
    // Constructing throws with a clear message when Stripe's secrets are missing, which is
    // a better answer than silently verifying against whatever else is configured.
    const provider = this.resolver.get(this.provider);
    if (!provider.verifySignedEnvelope) {
      throw new AppException(
        ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE,
        'Stripe webhooks are not supported by the configured Stripe adapter.',
        HttpStatus.NOT_IMPLEMENTED,
      );
    }

    // Signature verification against the exact raw body (throws PAYMENT_WEBHOOK_INVALID).
    const envelope: WebhookEnvelope = provider.verifySignedEnvelope({
      rawBody,
      signature,
    });

    // Idempotency: Stripe event ids are globally unique. A duplicate delivery that is
    // already processed (or in flight) is acknowledged without re-processing.
    const existing = await this.prisma.webhookEvent.findUnique({
      where: {
        provider_providerEventId: { provider: this.provider, providerEventId: envelope.id },
      },
    });
    if (
      existing &&
      (existing.processingStatus === WebhookProcessingStatus.PROCESSED ||
        existing.processingStatus === WebhookProcessingStatus.PROCESSING)
    ) {
      this.metrics.recordPaymentWebhook?.(this.provider, 'duplicate');
      return { received: true, duplicate: true };
    }

    const payloadHash = createHash('sha256').update(rawBody).digest('hex');
    const data = { account: envelope.account ?? null, object: envelope.object };

    const record = existing
      ? await this.prisma.webhookEvent.update({
          where: { id: existing.id },
          data: {
            processingStatus: WebhookProcessingStatus.RECEIVED,
            eventType: envelope.type,
            payloadHash,
            payload: data as object,
          },
        })
      : await this.prisma.webhookEvent.create({
          data: {
            provider: this.provider,
            providerEventId: envelope.id,
            eventType: envelope.type,
            payloadHash,
            payload: data as object,
            processingStatus: WebhookProcessingStatus.RECEIVED,
          },
        });

    this.metrics.recordPaymentWebhook?.(this.provider, envelope.type);

    // Best-effort fast path (non-blocking). The worker sweep retries anything missed,
    // so a failure here never loses the durably-accepted event. We still return 2xx fast.
    void this.processor.process(record.id).catch((err) => {
      this.logger.warn(
        `Inline processing of webhook ${envelope.id} failed (will retry via sweep): ${
          err instanceof Error ? err.message : err
        }`,
      );
    });

    return { received: true, duplicate: false };
  }
}
