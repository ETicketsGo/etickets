import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import twilio, { Twilio } from 'twilio';
import { DeliveryOutcome, RenderedNotification } from '../notification-channel.interface';
import { maskPhone, resolveDestination } from './recipient.util';
import { TransportError, transportJson } from './transport-http';

/** DI token for the SMS transport bound in notifications.module.ts. */
export const SMS_TRANSPORT = Symbol('SMS_TRANSPORT');

/** Which real/log transport an SMS route resolves to. */
export type SmsProviderName = 'log' | 'twilio' | 'msg91';

/** A single SMS-send transport. */
export interface SmsTransport {
  readonly name: SmsProviderName;
  send(msg: RenderedNotification): Promise<DeliveryOutcome>;
}

/** Nothing to send to. Not a failure — see DeliveryOutcome. */
function noRecipient(msg: RenderedNotification, logger: Logger, provider: string): DeliveryOutcome {
  logger.warn(
    `[sms:${msg.type}] no phone number on file -> skipped for user ${msg.userId ?? 'n/a'}`,
  );
  return { provider, skipped: true, reason: 'no_destination' };
}

/**
 * Default transport — logs locally, reproducing the original SmsChannel log so
 * existing tests/e2e are unaffected.
 */
export class SmsLogTransport implements SmsTransport {
  readonly name = 'log' as const;
  private readonly logger = new Logger('Notification');

  async send(msg: RenderedNotification): Promise<DeliveryOutcome> {
    this.logger.log(`[sms:${msg.type}] -> user ${msg.userId ?? 'n/a'} :: ${msg.body}`);
    return { provider: 'log' };
  }
}

/**
 * Twilio transport (North America). Requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and
 * TWILIO_FROM_NUMBER.
 */
export class TwilioSmsTransport implements SmsTransport {
  readonly name = 'twilio' as const;
  private readonly logger = new Logger('Notification');
  private readonly client: Twilio;
  private readonly from: string;

  constructor(config: ConfigService) {
    const accountSid = requireKey(config, 'twilio', 'TWILIO_ACCOUNT_SID');
    const authToken = requireKey(config, 'twilio', 'TWILIO_AUTH_TOKEN');
    this.from = requireKey(config, 'twilio', 'TWILIO_FROM_NUMBER');
    this.client = twilio(accountSid, authToken);
  }

  async send(msg: RenderedNotification): Promise<DeliveryOutcome> {
    const to = resolveDestination(msg);
    if (!to) return noRecipient(msg, this.logger, this.name);
    const created = await this.client.messages.create({ to, from: this.from, body: msg.body });
    return { provider: this.name, providerMessageId: created.sid };
  }
}

/**
 * MSG91 transport (India).
 *
 * ── WHY INDIA CANNOT USE TWILIO'S SHAPE ────────────────────────────────────────────
 * An Indian operator will not carry a transactional SMS whose wording is not a template
 * registered against the sender on a DLT portal, and will not carry it under a sender id
 * that is not registered either. So there is no "here is some text, send it": the request
 * names an APPROVED TEMPLATE and supplies its variables, and the approved wording lives at
 * the operator, not in this repository.
 *
 * That is why the template ids are configuration and why none of them have defaults. A
 * hardcoded template id is a compliance decision baked into a build, and a wrong one is a
 * message that is accepted by the API and then silently dropped by the carrier.
 *
 * ── WHAT MUST BE SET UP OUTSIDE THIS CODE ──────────────────────────────────────────
 * An MSG91 account, a DLT-registered sender id, and one approved template per message type,
 * with its variable names. None of that can be created from here and none of it is faked in
 * tests: with no template id configured for a type this transport refuses the send with a
 * permanent error rather than guessing one.
 *
 * ── ON THE REQUEST SHAPE ───────────────────────────────────────────────────────────
 * This is written against MSG91's published v5 flow API. The base URL and path are
 * configurable precisely because a vendor's API is not something this repository can assert
 * from the outside: verify it against the account's own documentation before enabling, which
 * is what EXTERNAL SETUP REQUIRED in the report means.
 */
export class Msg91SmsTransport implements SmsTransport {
  readonly name = 'msg91' as const;
  private readonly logger = new Logger('Notification');
  private readonly authKey: string;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly templateIds: Record<string, string>;
  private readonly defaultTemplateId?: string;
  private readonly senderId?: string;
  private readonly bodyVar: string;

  constructor(config: ConfigService) {
    this.authKey = requireKey(config, 'msg91', 'MSG91_AUTH_KEY');
    const base = (config.get<string>('MSG91_BASE_URL') ?? 'https://control.msg91.com').replace(
      /\/+$/,
      '',
    );
    this.url = `${base}${config.get<string>('MSG91_SMS_PATH') ?? '/api/v5/flow'}`;
    this.timeoutMs = Number(config.get('MSG91_TIMEOUT_MS') ?? 10_000);
    this.templateIds = parseTemplateIds(config.get<string>('MSG91_SMS_TEMPLATE_IDS'));
    this.defaultTemplateId = config.get<string>('MSG91_SMS_TEMPLATE_ID') ?? undefined;
    this.senderId = config.get<string>('MSG91_SENDER_ID') ?? undefined;
    this.bodyVar = config.get<string>('MSG91_SMS_BODY_VAR') ?? 'body';
  }

  async send(msg: RenderedNotification): Promise<DeliveryOutcome> {
    const to = resolveDestination(msg);
    if (!to) return noRecipient(msg, this.logger, this.name);

    const templateId = this.templateIds[msg.type] ?? this.defaultTemplateId;
    if (!templateId) {
      /*
        Permanent on purpose. There is no template to retry with, and retrying twelve times
        over an hour would only delay the moment somebody notices the configuration is
        incomplete. The message names the exact key to set.
      */
      throw new TransportError(
        `MSG91 has no DLT template configured for ${msg.type}. ` +
          `Set MSG91_SMS_TEMPLATE_IDS=${msg.type}=<template_id> (or MSG91_SMS_TEMPLATE_ID).`,
        this.name,
        false,
      );
    }

    /*
      Structured variables from the caller when it has them, otherwise the rendered message as
      one variable. Both exist because a DLT template can be either shape: a sentence with
      named slots ("Your booking ##ref## is confirmed"), or a single variable that the
      approved wording wraps. Which one an account has is the account's business.
    */
    const vars =
      (msg.payload?.['smsTemplateVars'] as Record<string, unknown> | undefined) ??
      ({ [this.bodyVar]: msg.body } as Record<string, unknown>);

    const { data } = await transportJson<Msg91Response>(this.name, this.url, {
      method: 'POST',
      timeoutMs: this.timeoutMs,
      headers: {
        // MSG91 authenticates with this header. It is never logged and never echoed back.
        authkey: this.authKey,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        template_id: templateId,
        ...(this.senderId ? { sender: this.senderId } : {}),
        short_url: '0',
        realTimeResponse: '1',
        // MSG91 wants the number without a leading '+'.
        recipients: [{ mobiles: to.replace(/^\+/, ''), ...vars }],
      }),
    });

    /*
      MSG91 answers HTTP 200 for a refusal as well as an acceptance, distinguishing them in
      `type`. Treating 200 as success would record "sent" for messages the provider had just
      told us it would not carry — which is the exact class of lie this phase set out to
      remove from the status column.
    */
    if (data?.type && data.type !== 'success') {
      throw new TransportError(
        `MSG91 refused the message: ${data.message ?? data.type}`,
        this.name,
        false,
      );
    }
    this.logger.log(`[sms:${msg.type}] msg91 accepted -> ${maskPhone(to)}`);
    return {
      provider: this.name,
      providerMessageId: typeof data?.message === 'string' ? data.message : null,
    };
  }
}

interface Msg91Response {
  type?: string;
  message?: string;
}

/** `BOOKING_CANCELLED=1234,REFUND_COMPLETED=5678` → a lookup by notification type. */
export function parseTemplateIds(raw: string | null | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const entry of (raw ?? '').split(',')) {
    const [type, id] = entry.split('=');
    if (type?.trim() && id?.trim()) map[type.trim()] = id.trim();
  }
  return map;
}

/** Construct one named SMS transport. Only the ones a route needs are ever built. */
export function buildSmsTransport(name: SmsProviderName, config: ConfigService): SmsTransport {
  switch (name) {
    case 'twilio':
      return new TwilioSmsTransport(config);
    case 'msg91':
      return new Msg91SmsTransport(config);
    case 'log':
    default:
      return new SmsLogTransport();
  }
}

/**
 * Resolves the DEFAULT SMS transport from SMS_PROVIDER (default `log`) — the answer when no
 * market routing table is configured, which is every single-market and local setup.
 */
export function selectSmsTransport(config: ConfigService): SmsTransport {
  return buildSmsTransport(config.get<SmsProviderName>('SMS_PROVIDER') ?? 'log', config);
}

function requireKey(config: ConfigService, provider: string, key: string): string {
  const value = config.get<string>(key);
  if (!value) {
    throw new Error(
      `SMS provider "${provider}" requires ${key} to be set. ` +
        `Use sandbox credentials for QA, live credentials for production.`,
    );
  }
  return value;
}
