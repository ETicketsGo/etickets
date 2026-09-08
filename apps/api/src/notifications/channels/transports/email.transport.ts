import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sgMail from '@sendgrid/mail';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { DeliveryOutcome, RenderedNotification } from '../notification-channel.interface';

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
  readonly name: EmailProviderName;
  send(msg: RenderedNotification): Promise<DeliveryOutcome>;
}

/**
 * Default transport — logs the email locally, byte-for-byte reproducing the
 * original EmailChannel log so existing tests/e2e are unaffected.
 */
export class EmailLogTransport implements EmailTransport {
  readonly name = 'log' as const;
  private readonly logger = new Logger('Notification');

  async send(msg: RenderedNotification): Promise<DeliveryOutcome> {
    this.logger.log(
      `[email:${msg.type}] -> ${msg.toEmail ?? 'n/a'} :: ${JSON.stringify(msg.payload)}`,
    );
    return { provider: 'log' };
  }
}

/** SendGrid transport (`@sendgrid/mail`). Requires SENDGRID_API_KEY + EMAIL_FROM. */
export class SendGridEmailTransport implements EmailTransport {
  readonly name = 'sendgrid' as const;
  private readonly from: string;

  constructor(config: ConfigService) {
    const apiKey = requireKey(config, 'SENDGRID_API_KEY');
    this.from = requireKey(config, 'EMAIL_FROM');
    sgMail.setApiKey(apiKey);
  }

  async send(msg: RenderedNotification): Promise<DeliveryOutcome> {
    if (!msg.toEmail) {
      throw new Error('EmailTransport: rendered notification has no recipient (toEmail).');
    }
    const [res] = await sgMail.send({
      to: msg.toEmail,
      from: this.from,
      subject: msg.subject,
      text: msg.body,
    });
    // SendGrid returns its queue id in a response header; absent, the send still happened.
    const id = res?.headers?.['x-message-id'];
    return { provider: this.name, providerMessageId: typeof id === 'string' ? id : null };
  }
}

/** AWS SES v2 transport (`@aws-sdk/client-sesv2`). Requires AWS_REGION + EMAIL_FROM. */
export class SesEmailTransport implements EmailTransport {
  readonly name = 'ses' as const;
  private readonly from: string;
  private readonly client: SESv2Client;
  /**
   * The SES configuration set, without which NO EVENT IS EVER PUBLISHED.
   *
   * ── WHY THIS IS NOT OPTIONAL IN PRACTICE ───────────────────────────────────────────
   * SES emits delivery, bounce and complaint events through an event destination attached to
   * a CONFIGURATION SET, and it only does so for messages sent WITH that configuration set
   * named on them. Omit it and everything works: the mail goes out, the API returns a message
   * id, the row says ACCEPTED — and not one callback ever arrives, so nothing is ever marked
   * delivered and no bounce ever suppresses anything.
   *
   * That failure is completely silent from this side. The SNS topic is configured, the
   * subscription is confirmed, the endpoint verifies signatures, and the reason nothing
   * happens is one absent field on the send. It is left nullable only because a deployment
   * that genuinely does not want events should not be forced to invent a name.
   */
  private readonly configurationSet?: string;

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
    this.configurationSet = config.get<string>('SES_CONFIGURATION_SET') ?? undefined;
  }

  async send(msg: RenderedNotification): Promise<DeliveryOutcome> {
    if (!msg.toEmail) {
      throw new Error('EmailTransport: rendered notification has no recipient (toEmail).');
    }
    const res = await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: [msg.toEmail] },
        // Without this, SES publishes no events for the message and no callback ever arrives.
        ...(this.configurationSet ? { ConfigurationSetName: this.configurationSet } : {}),
        Content: {
          Simple: {
            Subject: { Data: msg.subject },
            Body: { Text: { Data: msg.body } },
          },
        },
      }),
    );
    // SES's own message id, which is what an AWS support case is opened against.
    return { provider: this.name, providerMessageId: res.MessageId ?? null };
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
