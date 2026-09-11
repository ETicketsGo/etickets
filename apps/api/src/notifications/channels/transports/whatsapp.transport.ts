import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FailureClass } from '@eticketsgo/shared-types';
import type { TemplateBindingService } from '../../templates/template-binding.service';
import { DeliveryOutcome, RenderedNotification } from '../notification-channel.interface';
import { maskPhone, resolveDestination } from './recipient.util';
import { TransportError, transportJson } from './transport-http';
import { messageContentLoggable } from './content-logging';

/** DI token for the WhatsApp transport bound in notifications.module.ts. */
export const WHATSAPP_TRANSPORT = Symbol('WHATSAPP_TRANSPORT');

/** Which real/log transport a WhatsApp route resolves to. */
export type WhatsAppProviderName = 'log' | 'cloud' | 'msg91';

/** A single WhatsApp-send transport. */
export interface WhatsAppTransport {
  readonly name: WhatsAppProviderName;
  send(msg: RenderedNotification): Promise<DeliveryOutcome>;
}

function noRecipient(msg: RenderedNotification, logger: Logger, provider: string): DeliveryOutcome {
  logger.warn(
    `[whatsapp:${msg.type}] no phone number on file -> skipped for user ${msg.userId ?? 'n/a'}`,
  );
  return { provider, skipped: true, reason: 'no_destination' };
}

/**
 * Sends nothing; says so in the log. The body is printed only in LOCAL/DEV, for the same
 * reason as `SmsLogTransport`: a message body is the customer's booking, and outside a
 * developer's laptop it does not belong in a retained log.
 */
export class WhatsAppLogTransport implements WhatsAppTransport {
  readonly name = 'log' as const;
  private readonly logger = new Logger('Notification');
  private readonly printBodies: boolean;

  constructor(config?: Pick<ConfigService, 'get'>) {
    this.printBodies = messageContentLoggable(config);
  }

  async send(msg: RenderedNotification): Promise<DeliveryOutcome> {
    if (this.printBodies) {
      this.logger.log(`[whatsapp:${msg.type}] -> user ${msg.userId ?? 'n/a'} :: ${msg.body}`);
    } else {
      this.logger.log(
        `[whatsapp:${msg.type}] not sent (WhatsApp is in log mode); content withheld -> ` +
          `${maskPhone(resolveDestination(msg))}`,
      );
    }
    return { provider: 'log' };
  }
}

/**
 * WhatsApp Business Cloud API transport (North America), talking to Meta directly with no
 * business solution provider in between. Requires WHATSAPP_PHONE_NUMBER_ID and
 * WHATSAPP_ACCESS_TOKEN.
 *
 * This already existed and already worked in every market; it is kept as the North American
 * route rather than replaced by a second vendor, because a working integration is worth more
 * than a uniform one.
 */
export class CloudWhatsAppTransport implements WhatsAppTransport {
  readonly name = 'cloud' as const;
  private readonly logger = new Logger('Notification');
  private readonly url: string;
  private readonly accessToken: string;
  private readonly bindings?: TemplateBindingService;
  private readonly languageCode: string;

  constructor(config: ConfigService, bindings?: TemplateBindingService) {
    const phoneNumberId = requireKey(config, 'cloud', 'WHATSAPP_PHONE_NUMBER_ID');
    this.accessToken = requireKey(config, 'cloud', 'WHATSAPP_ACCESS_TOKEN');
    this.url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;
    this.bindings = bindings;
    this.languageCode = config.get<string>('WHATSAPP_TEMPLATE_LANGUAGE') ?? 'en';
  }

  /**
   * Send a message as an APPROVED TEMPLATE.
   *
   * -- WHY THIS NO LONGER SENDS `type: 'text'` ---------------------------------------
   * It did, and that could never have worked for anything this platform sends. WhatsApp
   * permits free-form text only inside a 24-hour window that the RECIPIENT opens by writing
   * to the business first. Every message here is business-initiated -- a booking
   * confirmation, a cancelled show -- so no such window exists, and Meta refuses the send.
   *
   * The refusal would have arrived as a 400 on every North American WhatsApp message, at the
   * moment credentials were first configured, and it would have read as a credential problem
   * rather than a message-shape one. The MSG91 transport below already sent templates for
   * exactly this reason; the two are now the same shape, which is what the capability matrix
   * has said all along (`cloud.requiresTemplate = true`).
   */
  async send(msg: RenderedNotification): Promise<DeliveryOutcome> {
    const to = resolveDestination(msg);
    if (!to) return noRecipient(msg, this.logger, this.name);

    const bound = this.bindings?.resolve({
      provider: this.name,
      channel: 'whatsapp',
      type: msg.type,
      locale: msg.locale,
    });
    if (!bound) {
      throw new TransportError(
        `Meta WhatsApp has no approved template bound for ${msg.type} ` +
          `(locale ${msg.locale ?? '*'}). Set ` +
          `NOTIFICATION_TEMPLATE_BINDINGS=cloud:whatsapp:${msg.type}:*=<template_name>.`,
        this.name,
        FailureClass.TEMPLATE_NOT_FOUND,
      );
    }

    /*
      Meta's template variables are positional. A caller that knows the approved template
      supplies them in order; otherwise the rendered message goes in as the single first
      variable, which is what a one-slot template expects -- the same contract the MSG91
      transport offers, so a producer never has to know which BSP is carrying it.
    */
    const values = Array.isArray(msg.payload?.['whatsappTemplateVars'])
      ? (msg.payload['whatsappTemplateVars'] as unknown[]).map((v) => String(v))
      : [msg.body];

    const { data } = await transportJson<CloudResponse>(this.name, this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: bound.externalId,
          // The binding's locale is the language the template was APPROVED in, which is more
          // specific than any process-wide default, so it wins whenever it is not a wildcard.
          language: { code: bound.locale === '*' ? this.languageCode : bound.locale },
          components: [
            {
              type: 'body',
              parameters: values.map((value) => ({ type: 'text', text: value })),
            },
          ],
        },
      }),
    });
    this.logger.log(`[whatsapp:${msg.type}] cloud accepted -> ${maskPhone(to)}`);
    return { provider: this.name, providerMessageId: data?.messages?.[0]?.id ?? null };
  }
}

interface CloudResponse {
  messages?: { id?: string }[];
}

/**
 * MSG91 WhatsApp transport (India), sending through MSG91 as the business solution provider.
 *
 * ── WHY A TEMPLATE IS NOT OPTIONAL ─────────────────────────────────────────────────
 * WhatsApp only permits free-form text inside a 24-hour window opened by the recipient
 * writing first. A booking confirmation is not that: it is business-initiated, so it must go
 * as an approved template, and the approval lives with Meta and the BSP. Same reasoning as
 * the SMS transport — the wording is not ours, so the template name is configuration, has no
 * default, and its absence is a permanent refusal rather than a guess.
 *
 * ── WHAT MUST BE SET UP OUTSIDE THIS CODE ──────────────────────────────────────────
 * An MSG91 WhatsApp account, a verified business number registered with them, and one
 * approved template per message type. The request shape below follows MSG91's published
 * WhatsApp API; the base URL and path are configurable so it can be corrected against the
 * account's own documentation without a code change.
 */
export class Msg91WhatsAppTransport implements WhatsAppTransport {
  readonly name = 'msg91' as const;
  private readonly logger = new Logger('Notification');
  private readonly authKey: string;
  private readonly url: string;
  private readonly integratedNumber: string;
  private readonly timeoutMs: number;
  private readonly templates: Record<string, string>;
  private readonly defaultTemplate?: string;
  private readonly languageCode: string;
  /** Canonical bindings when wired; the environment map below otherwise. */
  private readonly bindings?: TemplateBindingService;

  constructor(config: ConfigService, bindings?: TemplateBindingService) {
    this.authKey = requireKey(config, 'msg91', 'MSG91_AUTH_KEY');
    this.integratedNumber = requireKey(config, 'msg91', 'MSG91_WHATSAPP_NUMBER');
    this.bindings = bindings;
    const base = (config.get<string>('MSG91_BASE_URL') ?? 'https://control.msg91.com').replace(
      /\/+$/,
      '',
    );
    this.url = `${base}${
      config.get<string>('MSG91_WHATSAPP_PATH') ??
      '/api/v5/whatsapp/whatsapp-outbound-message/bulk/'
    }`;
    this.timeoutMs = Number(config.get('MSG91_TIMEOUT_MS') ?? 10_000);
    this.templates = parseTemplateNames(config.get<string>('MSG91_WHATSAPP_TEMPLATES'));
    this.defaultTemplate = config.get<string>('MSG91_WHATSAPP_TEMPLATE') ?? undefined;
    this.languageCode = config.get<string>('MSG91_WHATSAPP_LANGUAGE') ?? 'en';
  }

  async send(msg: RenderedNotification): Promise<DeliveryOutcome> {
    const to = resolveDestination(msg);
    if (!to) return noRecipient(msg, this.logger, this.name);

    const bound = this.bindings?.resolve({
      provider: this.name,
      channel: 'whatsapp',
      type: msg.type,
      locale: msg.locale,
    });
    const templateName = bound?.externalId ?? this.templates[msg.type] ?? this.defaultTemplate;
    if (!templateName) {
      throw new TransportError(
        `MSG91 has no approved WhatsApp template bound for ${msg.type} ` +
          `(locale ${msg.locale ?? '*'}). Set ` +
          `NOTIFICATION_TEMPLATE_BINDINGS=msg91:whatsapp:${msg.type}:*=<template_name>.`,
        this.name,
        FailureClass.TEMPLATE_NOT_FOUND,
      );
    }

    /*
      A template's body variables are positional in WhatsApp's model. A caller that knows the
      template supplies them in order; otherwise the rendered message goes in as the single
      first variable, which is what a one-slot template expects.
    */
    const components = Array.isArray(msg.payload?.['whatsappTemplateVars'])
      ? (msg.payload['whatsappTemplateVars'] as unknown[]).map((v) => String(v))
      : [msg.body];

    const { data } = await transportJson<Msg91WhatsAppResponse>(this.name, this.url, {
      method: 'POST',
      timeoutMs: this.timeoutMs,
      headers: {
        authkey: this.authKey,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        integrated_number: this.integratedNumber,
        content_type: 'template',
        payload: {
          messaging_product: 'whatsapp',
          type: 'template',
          template: {
            name: templateName,
            language: {
              code: bound && bound.locale !== '*' ? bound.locale : this.languageCode,
              policy: 'deterministic',
            },
            to_and_components: [
              {
                to: [to.replace(/^\+/, '')],
                components: Object.fromEntries(
                  components.map((value, i) => [String(i + 1), { type: 'text', value }]),
                ),
              },
            ],
          },
        },
      }),
    });

    if (data?.status && data.status !== 'success') {
      throw new TransportError(
        `MSG91 refused the WhatsApp message: ${data.message ?? data.status}`,
        this.name,
        FailureClass.PERMANENT_REJECTION,
      );
    }
    this.logger.log(`[whatsapp:${msg.type}] msg91 accepted -> ${maskPhone(to)}`);
    return {
      provider: this.name,
      providerMessageId: typeof data?.request_id === 'string' ? data.request_id : null,
    };
  }
}

interface Msg91WhatsAppResponse {
  status?: string;
  message?: string;
  request_id?: string;
}

/** `BOOKING_CONFIRMED=booking_confirmed_v1,...` → an approved template name per type. */
export function parseTemplateNames(raw: string | null | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const entry of (raw ?? '').split(',')) {
    const [type, name] = entry.split('=');
    if (type?.trim() && name?.trim()) map[type.trim()] = name.trim();
  }
  return map;
}

/** Construct one named WhatsApp transport. Only the ones a route needs are ever built. */
export function buildWhatsAppTransport(
  name: WhatsAppProviderName,
  config: ConfigService,
  bindings?: TemplateBindingService,
): WhatsAppTransport {
  switch (name) {
    case 'cloud':
      return new CloudWhatsAppTransport(config, bindings);
    case 'msg91':
      return new Msg91WhatsAppTransport(config, bindings);
    case 'log':
    default:
      return new WhatsAppLogTransport(config);
  }
}

/** The DEFAULT WhatsApp transport, used when no market routing table is configured. */
export function selectWhatsAppTransport(config: ConfigService): WhatsAppTransport {
  return buildWhatsAppTransport(
    config.get<WhatsAppProviderName>('WHATSAPP_PROVIDER') ?? 'log',
    config,
  );
}

/** A missing credential is OUR configuration, never the provider's failure. See sms.transport. */
function requireKey(config: ConfigService, provider: string, key: string): string {
  const value = config.get<string>(key);
  if (!value) {
    throw new TransportError(
      `WhatsApp provider "${provider}" requires ${key} to be set. ` +
        `Use a test number/token for sandbox, live credentials for production.`,
      provider,
      FailureClass.CONFIGURATION_ERROR,
    );
  }
  return value;
}
