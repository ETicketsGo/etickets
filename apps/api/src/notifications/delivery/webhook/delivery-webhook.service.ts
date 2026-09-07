import { createHash } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhookProcessingStatus } from '@eticketsgo/shared-types';
import { PrismaService } from '../../../prisma/prisma.service';
import { MetricsService } from '../../../metrics/metrics.service';
import { AppException, ErrorCodes } from '../../../common/errors';
import { DeliveryRecorderService } from '../delivery-recorder.service';
import {
  parseMetaCloud,
  parseMsg91,
  parseSesEvent,
  parseTwilio,
  type DeliveryEvent,
} from './delivery-webhook.parsers';
import {
  snsMessageType,
  verifyMetaSignature,
  verifySharedSecret,
  verifyTwilioSignature,
} from './delivery-webhook.signatures';

export interface WebhookResult {
  received: true;
  applied: number;
  duplicate: boolean;
}

/**
 * Delivery callbacks, from every provider that sends them.
 *
 * ── WHY IT REUSES WebhookEvent ─────────────────────────────────────────────────────
 * The payments side solved this exact problem: a durable row keyed on
 * `(provider, providerEventId)` so a redelivery is a no-op, with the unique index as the
 * replay guarantee rather than anything held in memory. Building a second, parallel
 * ingestion table would mean two places to look when an event goes missing and two retry
 * stories to keep in step. This is the same table with a different provider prefix.
 *
 * ── WHY EVERY PATH RETURNS 2xx ─────────────────────────────────────────────────────
 * Except an invalid signature. A provider that gets a 5xx redelivers, with backoff, for
 * hours. If an event is genuinely unusable — a message id from another environment, a status
 * nobody mapped, a body that will never parse — then failing it means the provider keeps
 * sending it back forever and the real events queue behind it. So an unusable event is
 * recorded, counted, and acknowledged.
 *
 * An invalid signature is different: it is refused with a 401 and nothing is written, because
 * accepting an unverified event would let anyone suppress any destination they can name.
 */
@Injectable()
export class DeliveryWebhookService {
  private readonly logger = new Logger('NotificationWebhook');

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly recorder: DeliveryRecorderService,
    private readonly metrics: MetricsService,
  ) {}

  /** Twilio SMS status callbacks (form-encoded, HMAC-SHA1 over URL + sorted fields). */
  async twilio(input: {
    url: string;
    body: Record<string, unknown>;
    signature: string;
  }): Promise<WebhookResult> {
    const token = this.config.get<string>('TWILIO_AUTH_TOKEN');
    if (!token || !verifyTwilioSignature(token, input.url, input.body, input.signature)) {
      this.reject('twilio');
    }
    const event = parseTwilio(input.body);
    return this.ingest('twilio', event ? [event] : [], input.body);
  }

  /** Meta WhatsApp Cloud status callbacks (HMAC-SHA256 over the RAW body). */
  async metaCloud(input: { rawBody: string; signature: string }): Promise<WebhookResult> {
    const secret = this.config.get<string>('WHATSAPP_APP_SECRET');
    if (!secret || !verifyMetaSignature(secret, input.rawBody, input.signature)) {
      this.reject('cloud');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.rawBody);
    } catch {
      // Signed but unparseable. Acknowledged rather than 500'd: redelivering a body that
      // will never parse achieves nothing except filling the provider's retry queue.
      this.metrics.recordNotificationWebhook('cloud', 'malformed');
      return { received: true, applied: 0, duplicate: false };
    }
    return this.ingest('cloud', parseMetaCloud(parsed), parsed);
  }

  /**
   * MSG91 delivery reports, authenticated by a shared secret in the callback URL.
   *
   * MSG91 publishes no signing scheme. This is weaker than a signature and is documented as
   * such — it authenticates the CALLER, not the body.
   */
  async msg91(input: { secret: string; body: Record<string, unknown> }): Promise<WebhookResult> {
    if (!verifySharedSecret(this.config.get<string>('MSG91_WEBHOOK_SECRET'), input.secret)) {
      this.reject('msg91');
    }
    const event = parseMsg91(input.body);
    return this.ingest('msg91', event ? [event] : [], input.body);
  }

  /**
   * SES delivery, bounce and complaint notifications, arriving over SNS.
   *
   * SNS confirms a subscription by POSTing a `SubscriptionConfirmation` with a URL that must
   * be fetched. That fetch is deliberately NOT automatic: an endpoint that confirms whatever
   * subscription is offered will attach itself to any topic anybody points at it. The token
   * is logged so an operator can confirm it once, on purpose.
   */
  async ses(input: {
    secret: string;
    headers: Record<string, unknown>;
    body: Record<string, unknown>;
  }): Promise<WebhookResult> {
    if (!verifySharedSecret(this.config.get<string>('SES_WEBHOOK_SECRET'), input.secret)) {
      this.reject('ses');
    }

    const type = snsMessageType(input.headers, input.body);
    if (type === 'SubscriptionConfirmation') {
      this.logger.warn(
        'SNS subscription confirmation received. Confirm it deliberately in the AWS console; ' +
          'this endpoint does not auto-confirm. SubscribeURL host: ' +
          hostOf(input.body.SubscribeURL),
      );
      this.metrics.recordNotificationWebhook('ses', 'subscription_confirmation');
      return { received: true, applied: 0, duplicate: false };
    }

    // The SES event is a JSON string inside the SNS envelope.
    let message: unknown = input.body.Message;
    if (typeof message === 'string') {
      try {
        message = JSON.parse(message);
      } catch {
        this.metrics.recordNotificationWebhook('ses', 'malformed');
        return { received: true, applied: 0, duplicate: false };
      }
    }
    return this.ingest('ses', parseSesEvent(message), message);
  }

  private reject(provider: string): never {
    this.metrics.recordNotificationWebhook(provider, 'signature_invalid');
    // Deliberately vague: a caller probing the endpoint learns nothing about which part of
    // the verification failed.
    throw new AppException(
      ErrorCodes.UNAUTHORIZED,
      'Webhook signature verification failed.',
      HttpStatus.UNAUTHORIZED,
    );
  }

  /**
   * Record the events durably, then apply them.
   *
   * Recording first is what makes a redelivery a no-op: the unique index on
   * `(provider, providerEventId)` is the replay guarantee, and it is in the database rather
   * than in this process, so two API instances receiving the same retry cannot both apply it.
   */
  private async ingest(
    provider: string,
    events: DeliveryEvent[],
    rawPayload: unknown,
  ): Promise<WebhookResult> {
    if (events.length === 0) {
      /*
        Signed, parsed, and carrying nothing this platform acts on -- a `Send` event nobody
        subscribed to, a status code MSG91 has not documented. Acknowledged so the provider
        stops redelivering it, and counted so a sudden run of them is visible.
      */
      this.metrics.recordNotificationWebhook(provider, 'no_actionable_event');
      return { received: true, applied: 0, duplicate: false };
    }

    let applied = 0;
    let duplicate = false;
    for (const event of events) {
      const claimed = await this.claim(provider, event, rawPayload);
      if (!claimed) {
        duplicate = true;
        this.metrics.recordNotificationWebhook(provider, 'duplicate');
        continue;
      }
      const outcome = await this.recorder.applyProviderEvent({
        provider,
        providerMessageId: event.providerMessageId,
        state: event.state,
        providerStatus: event.providerStatus,
        failureCode: event.failureCode,
        failureReason: event.failureReason,
        destination: event.destination,
        occurredAt: event.occurredAt,
      });
      if (outcome === 'applied') {
        applied += 1;
        this.metrics.recordNotificationWebhook(provider, 'applied');
      }
      await this.prisma.webhookEvent
        .updateMany({
          where: { provider, providerEventId: event.eventId },
          data: {
            processingStatus:
              outcome === 'unknown'
                ? WebhookProcessingStatus.DEAD_LETTER
                : WebhookProcessingStatus.PROCESSED,
            processedAt: new Date(),
            errorMessage: outcome === 'unknown' ? 'no matching delivery attempt' : null,
          },
        })
        .catch(() => undefined);
    }
    return { received: true, applied, duplicate };
  }

  /**
   * Claim this event, or discover somebody already has.
   *
   * `createMany({ skipDuplicates })` rather than a create-and-catch: a unique violation would
   * abort the surrounding transaction, and a redelivery is an entirely normal thing for a
   * provider to do rather than an error condition.
   */
  private async claim(
    provider: string,
    event: DeliveryEvent,
    rawPayload: unknown,
  ): Promise<boolean> {
    const created = await this.prisma.webhookEvent.createMany({
      data: [
        {
          provider: `notification:${provider}`,
          providerEventId: event.eventId,
          eventType: event.providerStatus ?? event.state,
          payloadHash: createHash('sha256')
            .update(JSON.stringify(rawPayload ?? {}))
            .digest('hex'),
          /*
            The parsed event, not the provider's body. A raw Twilio callback carries the
            recipient's phone number and a raw SES bounce carries their email address, and
            this table is long-lived, widely readable and included in backups. What is kept
            is what an operator needs: which message, what happened, and why.
          */
          payload: {
            providerMessageId: event.providerMessageId,
            state: event.state,
            providerStatus: event.providerStatus ?? null,
            failureCode: event.failureCode ?? null,
          } as object,
          processingStatus: WebhookProcessingStatus.RECEIVED,
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1;
  }
}

/** Host only — an SNS SubscribeURL carries a token that should not reach a log. */
function hostOf(url: unknown): string {
  try {
    return new URL(String(url)).host;
  } catch {
    return 'unparseable';
  }
}
