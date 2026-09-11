import { createHash } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhookProcessingStatus } from '@eticketsgo/shared-types';
import { PrismaService } from '../../../prisma/prisma.service';
import { MetricsService } from '../../../metrics/metrics.service';
import { AppException, ErrorCodes } from '../../../common/errors';
import { DeliveryRecorderService } from '../delivery-recorder.service';
import { SuppressionService } from '../suppression.service';
import { redactProviderText } from '../../channels/transports/provider-text';
import {
  TWILIO_INBOUND,
  applyOptOut,
  ledgerKey,
  settleWebhookEvent,
  type StoredOptOutEvent,
  type StoredProviderEvent,
} from './provider-event-ledger';
import {
  parseMetaCloud,
  parseMsg91,
  parseSesEvent,
  parseTwilio,
  parseTwilioInbound,
  type DeliveryEvent,
} from './delivery-webhook.parsers';
import {
  snsMessageType,
  verifyMetaSignature,
  verifySharedSecret,
  verifyTwilioSignature,
} from './delivery-webhook.signatures';
import { SnsVerifier, type SnsEnvelope } from './sns-verifier';
import { SnsConfirmationService } from './sns-confirmation.service';

export interface WebhookResult {
  received: true;
  applied: number;
  duplicate: boolean;
}

/**
 * Which channels a provider's callbacks can be about, so a destination can be kept as a hash
 * per channel (see DestinationRef). The hash includes the channel, and MSG91 carries two.
 */
const CALLBACK_CHANNELS: Record<string, readonly string[]> = {
  twilio: ['sms'],
  msg91: ['sms', 'whatsapp'],
  cloud: ['whatsapp'],
  ses: ['email'],
};

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
    /*
      Optional so the suites that construct this service directly keep working. When it is
      absent the endpoint falls back to the path secret alone -- which is the Phase 2
      behaviour and is refused in production by the boot check, because a suppression endpoint
      protected only by a URL is a way to stop a chosen person receiving their tickets.
    */
    private readonly sns?: SnsVerifier,
    /*
      Optional for the same reason as the verifier: the suites that construct this service by
      hand pass neither, and a confirmation that is not captured is a missing convenience
      rather than a broken webhook.
    */
    private readonly confirmations?: SnsConfirmationService,
    /*
      Required by the inbound opt-out webhook, which writes suppression directly. Optional in
      the signature only so the suites that build this service by hand for other providers
      keep working; the module always provides it.
    */
    private readonly suppression?: SuppressionService,
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

  /**
   * Inbound SMS to the Messaging Service -- used for Advanced Opt-Out keywords and nothing else.
   *
   * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
   * A STOP is recorded locally as UNSUBSCRIBED, and scheduled messages then refuse to text the
   * number. The only other way this platform learned about a START was Twilio ACCEPTING a later
   * send -- but the local suppression is exactly what stops that send being attempted. A
   * customer who texted START could stay suppressed here indefinitely while Twilio would have
   * delivered to them. Twilio publishes no API to read its opt-out list, so the keyword itself,
   * as Twilio reports it to this webhook, is the synchronisation.
   *
   * ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────────────
   * It does not reply (Twilio already has, in the sender's language), does not read the message
   * body, does not store the number, and does not act on anything Twilio did not classify as an
   * opt-out keyword. It is not a conversation endpoint.
   *
   * Recorded in the same ledger as delivery callbacks, keyed on the inbound message SID, so a
   * redelivered STOP cannot re-suppress somebody who has since texted START.
   */
  async twilioInbound(input: {
    url: string;
    body: Record<string, unknown>;
    signature: string;
  }): Promise<{ applied: boolean; duplicate: boolean }> {
    const token = this.config.get<string>('TWILIO_AUTH_TOKEN');
    if (!token || !verifyTwilioSignature(token, input.url, input.body, input.signature)) {
      this.reject(TWILIO_INBOUND);
    }
    const event = parseTwilioInbound(input.body);
    if (!event) {
      // An ordinary reply, or Advanced Opt-Out is off. Acknowledged; nothing is kept.
      this.metrics.recordNotificationWebhook(TWILIO_INBOUND, 'no_actionable_event');
      return { applied: false, duplicate: false };
    }
    if (!this.suppression) {
      throw new Error('Inbound opt-out webhook requires SuppressionService');
    }

    const stored: StoredOptOutEvent = {
      kind: 'opt_out',
      optOutType: event.optOutType,
      destinationRef: SuppressionService.reference(event.from, ['sms']),
    };
    const claimedId = await this.claimRow(
      ledgerKey(TWILIO_INBOUND),
      event.messageSid,
      event.optOutType,
      stored,
      input.body,
    );
    if (!claimedId) {
      this.metrics.recordNotificationWebhook(TWILIO_INBOUND, 'duplicate');
      return { applied: false, duplicate: true };
    }

    const outcome = await applyOptOut(this.suppression, stored);
    await settleWebhookEvent(this.prisma, claimedId, outcome).catch(() => undefined);
    this.metrics.recordNotificationWebhook(
      TWILIO_INBOUND,
      outcome === 'applied' ? `opt_out_${event.optOutType.toLowerCase()}` : 'no_change',
    );
    return { applied: outcome === 'applied', duplicate: false };
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
   * subscription is offered will attach itself to any topic anybody points at it. Only the
   * URL's host is logged — the token is not — and outside production the URL is held for a
   * one-time authenticated reveal so an operator can confirm it once, on purpose.
   */
  async ses(input: {
    secret: string;
    headers: Record<string, unknown>;
    body: Record<string, unknown>;
  }): Promise<WebhookResult> {
    /*
      Two checks, in cheapness order. The path secret is defence in depth and costs a string
      comparison; the signature is the authority and may cost a certificate fetch. A caller
      that fails the first never reaches the second.
    */
    if (!verifySharedSecret(this.config.get<string>('SES_WEBHOOK_SECRET'), input.secret)) {
      this.reject('ses');
    }

    /*
      ── THE SIGNATURE IS AUTHORITATIVE ──────────────────────────────────────────────
      Phase 2 said in writing that the path secret authenticates the CALLER and not the BODY,
      and that distinction is the whole risk: anyone who learns the URL can post a bounce for
      any address, and a bounce SUPPRESSES a destination. That is a way to stop a chosen
      person receiving their tickets, quietly, leaving a row that looks exactly like a real
      one.
    */
    const verdict = this.sns
      ? await this.sns.verify(input.body as SnsEnvelope)
      : { ok: false as const, reason: 'unverified_no_verifier' as const };
    if (!verdict.ok) {
      this.logger.warn(`SNS message refused: ${verdict.reason}`);
      this.reject('ses');
    }

    const type = snsMessageType(input.headers, input.body);
    if (type === 'SubscriptionConfirmation' || type === 'UnsubscribeConfirmation') {
      /*
        ── WHY THE URL IS STILL NOT FOLLOWED ───────────────────────────────────────────
        Even now that the message is proven to be from Amazon, confirming automatically means
        this endpoint attaches itself to whatever topic somebody with an AWS account points at
        it -- and then trusts the events from it. The signature proves the SENDER, not that we
        WANT the subscription.

        So the HOST is logged and the token is not, and a person confirms it once, on purpose,
        in the console. It happens exactly as often as somebody sets up a topic.

        ── AND WHY THE TOKEN IS NOW HELD SOMEWHERE ─────────────────────────────────────
        Keeping the token out of the logs left the operator with no way to perform the manual
        step this design requires of them. Outside production, and only there, the URL is put
        in one row behind an authenticated capability that reveals it once (ADR-052). This
        runs AFTER the signature check above, so only a message proven to be from Amazon is
        ever stored.
      */
      this.logger.warn(
        `SNS ${type} received and SIGNATURE-VERIFIED. Confirm it deliberately in the AWS ` +
          `console; this endpoint does not auto-confirm. Host: ${hostOf(input.body.SubscribeURL)}`,
      );
      if (type === 'SubscriptionConfirmation' && this.confirmations) {
        /*
          An Unsubscribe token is deliberately not captured: acting on one would RE-subscribe,
          which is not a step any operator here needs, and the narrowest store is the safest.
        */
        await this.confirmations.capture({
          topicArn: typeof input.body.TopicArn === 'string' ? input.body.TopicArn : undefined,
          messageId: typeof input.body.MessageId === 'string' ? input.body.MessageId : undefined,
          subscribeUrl:
            typeof input.body.SubscribeURL === 'string' ? input.body.SubscribeURL : undefined,
        });
      }
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
      const claimedId = await this.claim(provider, event, rawPayload);
      if (!claimedId) {
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
        suppressionReason: event.suppressionReason,
        occurredAt: event.occurredAt,
      });
      if (outcome === 'applied') {
        applied += 1;
        this.metrics.recordNotificationWebhook(provider, 'applied');
      }
      /*
        An event for a message not yet correlated is HELD, not consumed. Its unique key is
        already written, so a redelivery would be refused as a duplicate: dropping it here
        would lose it permanently. See ProviderEventReplayService.
      */
      if (outcome === 'unknown') {
        this.metrics.recordNotificationWebhook(provider, 'awaiting_correlation');
      }
      await settleWebhookEvent(this.prisma, claimedId, outcome).catch(() => undefined);
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
  ): Promise<string | null> {
    const key = ledgerKey(provider);
    /*
      The parsed event, not the provider's body. A raw Twilio callback carries the
      recipient's phone number and a raw SES bounce carries their email address, and this
      table is long-lived, widely readable and included in backups. What is kept is what is
      needed to apply the event later: which message, what happened, and -- for a destination
      that may need suppressing -- a hash and a mask, never the number or the address.
    */
    const stored: StoredProviderEvent = {
      providerMessageId: event.providerMessageId,
      state: event.state,
      providerStatus: event.providerStatus ?? null,
      failureCode: event.failureCode ?? null,
      failureReason: event.failureReason ? redactProviderText(event.failureReason) : null,
      suppressionReason: event.suppressionReason ?? null,
      destinationRef: event.destination
        ? SuppressionService.reference(event.destination, CALLBACK_CHANNELS[provider] ?? [])
        : null,
      occurredAt: event.occurredAt ? event.occurredAt.toISOString() : null,
    };
    return this.claimRow(
      key,
      event.eventId,
      event.providerStatus ?? event.state,
      stored,
      rawPayload,
    );
  }

  /** Write one ledger row, or return null when its (provider, eventId) already exists. */
  private async claimRow(
    key: string,
    providerEventId: string,
    eventType: string,
    stored: object,
    rawPayload: unknown,
  ): Promise<string | null> {
    const created = await this.prisma.webhookEvent.createMany({
      data: [
        {
          provider: key,
          providerEventId,
          eventType,
          payloadHash: createHash('sha256')
            .update(JSON.stringify(rawPayload ?? {}))
            .digest('hex'),
          payload: stored,
          processingStatus: WebhookProcessingStatus.RECEIVED,
        },
      ],
      skipDuplicates: true,
    });
    if (created.count !== 1) return null;
    const row = await this.prisma.webhookEvent.findUnique({
      where: { provider_providerEventId: { provider: key, providerEventId } },
      select: { id: true },
    });
    return row?.id ?? null;
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
