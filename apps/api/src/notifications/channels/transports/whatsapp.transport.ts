import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RenderedNotification } from '../notification-channel.interface';
import { payloadPhone } from './recipient.util';

/** DI token for the WhatsApp transport bound in notifications.module.ts. */
export const WHATSAPP_TRANSPORT = Symbol('WHATSAPP_TRANSPORT');

/** Which real/log transport `WHATSAPP_PROVIDER` resolves to. */
export type WhatsAppProviderName = 'log' | 'cloud';

/** A single WhatsApp-send transport. */
export interface WhatsAppTransport {
  send(msg: RenderedNotification): Promise<void>;
}

/**
 * Default transport — logs locally, reproducing the original WhatsAppChannel log
 * so existing tests/e2e are unaffected.
 */
export class WhatsAppLogTransport implements WhatsAppTransport {
  private readonly logger = new Logger('Notification');

  async send(msg: RenderedNotification): Promise<void> {
    this.logger.log(`[whatsapp:${msg.type}] -> user ${msg.userId ?? 'n/a'} :: ${msg.body}`);
  }
}

/**
 * WhatsApp Business Cloud API transport (uses global `fetch`, no SDK). Requires
 * WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN. The recipient comes from
 * `payload.phone`; when absent the send is skipped (warn + return). A non-2xx
 * response throws so NotificationService's retry/FAILED path handles it.
 */
export class CloudWhatsAppTransport implements WhatsAppTransport {
  private readonly logger = new Logger('Notification');
  private readonly url: string;
  private readonly accessToken: string;

  constructor(config: ConfigService) {
    const phoneNumberId = requireKey(config, 'WHATSAPP_PHONE_NUMBER_ID');
    this.accessToken = requireKey(config, 'WHATSAPP_ACCESS_TOKEN');
    this.url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;
  }

  async send(msg: RenderedNotification): Promise<void> {
    const to = payloadPhone(msg);
    if (!to) {
      this.logger.warn(
        `[whatsapp:${msg.type}] no WhatsApp recipient (payload.phone missing) -> skipped for user ${
          msg.userId ?? 'n/a'
        }`,
      );
      return;
    }
    const res = await fetch(this.url, {
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
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `WhatsApp Cloud API send failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`,
      );
    }
  }
}

/**
 * Resolves the active WhatsApp transport from WHATSAPP_PROVIDER (default `log`).
 * Only the selected provider is constructed; a selected provider with missing
 * keys fails fast at construction.
 */
export function selectWhatsAppTransport(config: ConfigService): WhatsAppTransport {
  const name = config.get<WhatsAppProviderName>('WHATSAPP_PROVIDER') ?? 'log';
  switch (name) {
    case 'cloud':
      return new CloudWhatsAppTransport(config);
    case 'log':
    default:
      return new WhatsAppLogTransport();
  }
}

function requireKey(config: ConfigService, key: string): string {
  const value = config.get<string>(key);
  if (!value) {
    throw new Error(
      `WHATSAPP_PROVIDER=cloud requires ${key} to be set. ` +
        `Use a WhatsApp test number/token for sandbox, live credentials for production.`,
    );
  }
  return value;
}
