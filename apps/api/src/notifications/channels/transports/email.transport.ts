import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sgMail from '@sendgrid/mail';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { RenderedNotification } from '../notification-channel.interface';

/** DI token for the email transport bound in notifications.module.ts. */
export const EMAIL_TRANSPORT = Symbol('EMAIL_TRANSPORT');

/** Which real/log transport `EMAIL_PROVIDER` resolves to. */
export type EmailProviderName = 'log' | 'sendgrid' | 'ses';

/**
 * A single email-send transport. The channel delegates delivery here so the
 * provider (log/SendGrid/SES) can be swapped by config without touching the
 * NotificationChannel or NotificationService.
 */
export interface EmailTransport {
  send(msg: RenderedNotification): Promise<void>;
}

/**
 * Default transport — logs the email locally, byte-for-byte reproducing the
 * original EmailChannel log so existing tests/e2e are unaffected.
 */
export class EmailLogTransport implements EmailTransport {
  private readonly logger = new Logger('Notification');

  async send(msg: RenderedNotification): Promise<void> {
    this.logger.log(
      `[email:${msg.type}] -> ${msg.toEmail ?? 'n/a'} :: ${JSON.stringify(msg.payload)}`,
    );
  }
}

/** SendGrid transport (`@sendgrid/mail`). Requires SENDGRID_API_KEY + EMAIL_FROM. */
export class SendGridEmailTransport implements EmailTransport {
  private readonly from: string;

  constructor(config: ConfigService) {
    const apiKey = requireKey(config, 'SENDGRID_API_KEY');
    this.from = requireKey(config, 'EMAIL_FROM');
    sgMail.setApiKey(apiKey);
  }

  async send(msg: RenderedNotification): Promise<void> {
    if (!msg.toEmail) {
      throw new Error('EmailTransport: rendered notification has no recipient (toEmail).');
    }
    await sgMail.send({
      to: msg.toEmail,
      from: this.from,
      subject: msg.subject,
      text: msg.body,
    });
  }
}

/** AWS SES v2 transport (`@aws-sdk/client-sesv2`). Requires AWS_REGION + EMAIL_FROM. */
export class SesEmailTransport implements EmailTransport {
  private readonly from: string;
  private readonly client: SESv2Client;

  constructor(config: ConfigService) {
    const region = requireKey(config, 'AWS_REGION');
    this.from = requireKey(config, 'EMAIL_FROM');
    // Explicit static credentials when provided; otherwise fall back to the
    // default AWS credential provider chain (IAM role, shared config, etc.).
    const accessKeyId = config.get<string>('AWS_ACCESS_KEY_ID');
    const secretAccessKey = config.get<string>('AWS_SECRET_ACCESS_KEY');
    this.client = new SESv2Client({
      region,
      ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
    });
  }

  async send(msg: RenderedNotification): Promise<void> {
    if (!msg.toEmail) {
      throw new Error('EmailTransport: rendered notification has no recipient (toEmail).');
    }
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: [msg.toEmail] },
        Content: {
          Simple: {
            Subject: { Data: msg.subject },
            Body: { Text: { Data: msg.body } },
          },
        },
      }),
    );
  }
}

/**
 * Resolves the active email transport from EMAIL_PROVIDER (default `log`). Only
 * the selected provider is constructed, so SendGrid/SES keys are never required
 * unless that provider is chosen; a selected provider with missing keys fails
 * fast at construction.
 */
export function selectEmailTransport(config: ConfigService): EmailTransport {
  const name = config.get<EmailProviderName>('EMAIL_PROVIDER') ?? 'log';
  switch (name) {
    case 'sendgrid':
      return new SendGridEmailTransport(config);
    case 'ses':
      return new SesEmailTransport(config);
    case 'log':
    default:
      return new EmailLogTransport();
  }
}

function requireKey(config: ConfigService, key: string): string {
  const value = config.get<string>(key);
  if (!value) {
    throw new Error(
      `EMAIL_PROVIDER requires ${key} to be set. ` +
        `Use provider test credentials for sandbox, live credentials for production.`,
    );
  }
  return value;
}
