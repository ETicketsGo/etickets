import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { WebhookProcessingStatus } from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from '../../metrics/metrics.service';
import { AppException, ErrorCodes } from '../../common/errors';
import { PaymentProviderResolver } from '../provider/payment-provider.resolver';
import { RazorpayWebhookProcessor } from './razorpay-webhook.processor';

const PROVIDER = 'razorpay';

/**
 * Durable, idempotent Razorpay webhook ingestion. Verifies the HMAC signature against the
 * RAW body, then persists the event keyed on a STABLE dedup id: the X-Razorpay-Event-Id
 * header when present, else a SHA-256 of the raw body (same delivery → same key). Returns
 * fast; processing runs async (best-effort inline + the worker sweep retry/dead-letter).
 */
@Injectable()
export class RazorpayWebhookService {
  private readonly logger = new Logger(RazorpayWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PaymentProviderResolver,
    private readonly processor: RazorpayWebhookProcessor,
    private readonly metrics: MetricsService,
  ) {}

  async ingest(
    rawBody: string,
    signature: string,
    eventIdHeader?: string,
  ): Promise<{ received: true; duplicate: boolean }> {
    const provider = this.resolver.get(PROVIDER);
    if (!provider.verifySignedEnvelope) {
      throw new AppException(
        ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE,
        'Razorpay webhooks are not supported by the active provider.',
        HttpStatus.NOT_IMPLEMENTED,
      );
    }

    // Signature verification against the exact raw body (throws PAYMENT_WEBHOOK_INVALID).
    const envelope = provider.verifySignedEnvelope({ rawBody, signature });

    // Stable dedup id: Razorpay event ids are not guaranteed unique in the body, so use
    // the header if present, else a hash of the raw payload.
    const payloadHash = createHash('sha256').update(rawBody).digest('hex');
    const providerEventId =
      eventIdHeader && eventIdHeader.trim() ? eventIdHeader.trim() : payloadHash;

    const existing = await this.prisma.webhookEvent.findUnique({
      where: { provider_providerEventId: { provider: PROVIDER, providerEventId } },
    });
    if (
      existing &&
      (existing.processingStatus === WebhookProcessingStatus.PROCESSED ||
        existing.processingStatus === WebhookProcessingStatus.PROCESSING)
    ) {
      this.metrics.recordPaymentWebhook?.(PROVIDER, 'duplicate');
      return { received: true, duplicate: true };
    }

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
            provider: PROVIDER,
            providerEventId,
            eventType: envelope.type,
            payloadHash,
            payload: data as object,
            processingStatus: WebhookProcessingStatus.RECEIVED,
          },
        });

    this.metrics.recordPaymentWebhook?.(PROVIDER, envelope.type);

    void this.processor.process(record.id).catch((err) => {
      this.logger.warn(
        `Inline processing of Razorpay webhook failed (will retry via sweep): ${
          err instanceof Error ? err.message : err
        }`,
      );
    });

    return { received: true, duplicate: false };
  }
}
