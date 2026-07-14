import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import twilio, { Twilio } from 'twilio';
import { RenderedNotification } from '../notification-channel.interface';
import { payloadPhone } from './recipient.util';

/** DI token for the SMS transport bound in notifications.module.ts. */
export const SMS_TRANSPORT = Symbol('SMS_TRANSPORT');

/** Which real/log transport `SMS_PROVIDER` resolves to. */
export type SmsProviderName = 'log' | 'twilio';

/** A single SMS-send transport. */
export interface SmsTransport {
  send(msg: RenderedNotification): Promise<void>;
}

/**
 * Default transport — logs locally, reproducing the original SmsChannel log so
 * existing tests/e2e are unaffected.
 */
export class SmsLogTransport implements SmsTransport {
  private readonly logger = new Logger('Notification');

  async send(msg: RenderedNotification): Promise<void> {
    this.logger.log(`[sms:${msg.type}] -> user ${msg.userId ?? 'n/a'} :: ${msg.body}`);
  }
}

/**
 * Twilio transport. Requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and
 * TWILIO_FROM_NUMBER. The recipient phone number comes from `payload.phone`;
 * when absent the send is skipped (warn + return) rather than failing, because
 * the platform does not collect phone numbers yet.
 */
export class TwilioSmsTransport implements SmsTransport {
  private readonly logger = new Logger('Notification');
  private readonly client: Twilio;
  private readonly from: string;

  constructor(config: ConfigService) {
    const accountSid = requireKey(config, 'TWILIO_ACCOUNT_SID');
    const authToken = requireKey(config, 'TWILIO_AUTH_TOKEN');
    this.from = requireKey(config, 'TWILIO_FROM_NUMBER');
    this.client = twilio(accountSid, authToken);
  }

  async send(msg: RenderedNotification): Promise<void> {
    const to = payloadPhone(msg);
    if (!to) {
      this.logger.warn(
        `[sms:${msg.type}] no SMS recipient (payload.phone missing) -> skipped for user ${
          msg.userId ?? 'n/a'
        }`,
      );
      return;
    }
    await this.client.messages.create({ to, from: this.from, body: msg.body });
  }
}

/**
 * Resolves the active SMS transport from SMS_PROVIDER (default `log`). Only the
 * selected provider is constructed; a selected provider with missing keys fails
 * fast at construction.
 */
export function selectSmsTransport(config: ConfigService): SmsTransport {
  const name = config.get<SmsProviderName>('SMS_PROVIDER') ?? 'log';
  switch (name) {
    case 'twilio':
      return new TwilioSmsTransport(config);
    case 'log':
    default:
      return new SmsLogTransport();
  }
}

function requireKey(config: ConfigService, key: string): string {
  const value = config.get<string>(key);
  if (!value) {
    throw new Error(
      `SMS_PROVIDER=twilio requires ${key} to be set. ` +
        `Use Twilio test credentials for sandbox, live credentials for production.`,
    );
  }
  return value;
}
