import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeliveryOutcome, RenderedNotification } from '../notification-channel.interface';
import { maskPhone, resolveDestination } from './recipient.util';
import { TransportError, transportJson } from './transport-http';

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
 * Default transport — logs locally, reproducing the original WhatsAppChannel log
 * so existing tests/e2e are unaffected.
 */
export class WhatsAppLogTransport implements WhatsAppTransport {
  readonly name = 'log' as const;
  private readonly logger = new Logger('Notification');

  async send(msg: RenderedNotification): Promise<DeliveryOutcome> {
    this.logger.log(`[whatsapp:${msg.type}] -> user ${msg.userId ?? 'n/a'} :: ${msg.body}`);
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

  constructor(config: ConfigService) {
    const phoneNumberId = requireKey(config, 'cloud', 'WHATSAPP_PHONE_NUMBER_ID');
    this.accessToken = requireKey(config, 'cloud', 'WHATSAPP_ACCESS_TOKEN');
    this.url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;
  }

  async send(msg: RenderedNotification): Promise<DeliveryOutcome> {
    const to = resolveDestination(msg);
    if (!to) return noRecipient(msg, this.logger, this.name);

    const { data } = await transportJson<CloudResponse>(this.name, this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: msg.body },
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

  constructor(config: ConfigService) {
    this.authKey = requireKey(config, 'msg91', 'MSG91_AUTH_KEY');
    this.integratedNumber = requireKey(config, 'msg91', 'MSG91_WHATSAPP_NUMBER');
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

    const templateName = this.templates[msg.type] ?? this.defaultTemplate;
    if (!templateName) {
      throw new TransportError(
        `MSG91 has no approved WhatsApp template configured for ${msg.type}. ` +
          `Set MSG91_WHATSAPP_TEMPLATES=${msg.type}=<template_name>.`,
        this.name,
        false,
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
            language: { code: this.languageCode, policy: 'deterministic' },
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
        false,
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
): WhatsAppTransport {
  switch (name) {
    case 'cloud':
      return new CloudWhatsAppTransport(config);
    case 'msg91':
      return new Msg91WhatsAppTransport(config);
    case 'log':
    default:
      return new WhatsAppLogTransport();
  }
}

/** The DEFAULT WhatsApp transport, used when no market routing table is configured. */
export function selectWhatsAppTransport(config: ConfigService): WhatsAppTransport {
  return buildWhatsAppTransport(
    config.get<WhatsAppProviderName>('WHATSAPP_PROVIDER') ?? 'log',
    config,
  );
}

function requireKey(config: ConfigService, provider: string, key: string): string {
  const value = config.get<string>(key);
  if (!value) {
    throw new Error(
      `WhatsApp provider "${provider}" requires ${key} to be set. ` +
        `Use a test number/token for sandbox, live credentials for production.`,
    );
  }
  return value;
}
