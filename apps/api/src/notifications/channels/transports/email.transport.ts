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
    // The Reply-To is appended only when there is one, so every other line reads as it did.
    this.logger.log(
      `[email:${msg.type}] -> ${msg.toEmail ?? 'n/a'}` +
        `${msg.replyTo ? ` (reply-to ${msg.replyTo})` : ''} :: ${JSON.stringify(msg.payload)}`,
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
      // Set by the email channel for the few types allowed one, after checking the address.
      ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
      subject: msg.subject,
      // Both parts, always in this order: a reader whose client prefers text still gets the
      // message, and the HTML is an alternative to it rather than a replacement for it.
      text: msg.body,
      ...(msg.html ? { html: msg.html } : {}),
      // Marketing mail only: the one-click unsubscribe pair. See `listUnsubscribeHeaders`.
      ...(listUnsubscribeHeaders(msg) ? { headers: listUnsubscribeHeaders(msg)! } : {}),
    });
    // SendGrid returns its queue id in a response header; absent, the send still happened.
    const id = res?.headers?.['x-message-id'];
    return { provider: this.name, providerMessageId: typeof id === 'string' ? id : null };
  }
}

/** Where the SES client's key came from. Said in the readiness check, never the key itself. */
export type SesCredentialSource = 'dedicated' | 'shared' | 'default_chain';

/** Environments that serve real customers. Same set as the deliverability boot guard. */
const LIVE_APP_ENVS = ['STAGING', 'PRODUCTION'];

/**
 * Which AWS key the SES client signs with.
 *
 * -- WHY SES HAS ITS OWN KEY --------------------------------------------------------
 * `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` are also what the AWS default credential
 * chain reads, and the payment secret store (AwsSecretsManagerSecretManager) builds its client
 * from that chain. One shared pair therefore means the key that sends email can also read the
 * Razorpay and Stripe secrets. So production signs SES with `SES_AWS_ACCESS_KEY_ID` /
 * `SES_AWS_SECRET_ACCESS_KEY`, which no AWS SDK reads by itself: the send-only key can only
 * reach SES, and the secret store keeps exactly the credentials it had.
 *
 * Order:
 *   1. The dedicated pair, when set. Half a pair is refused: it is a typo, not a choice.
 *   2. In STAGING/PRODUCTION, nothing else. Falling back would quietly sign email with the
 *      payment-secrets key, which is the thing this exists to prevent. The boot guard
 *      (assertSesProductionReadiness) says the same earlier and more clearly.
 *   3. Elsewhere (QA, UAT, local), the shared pair as before, then the default chain, so an
 *      environment that is not moved over keeps working with its configuration unchanged.
 */
export function resolveSesCredentials(
  config: ConfigService,
): { accessKeyId: string; secretAccessKey: string; source: SesCredentialSource } | undefined {
  const sesKeyId = config.get<string>('SES_AWS_ACCESS_KEY_ID')?.trim();
  const sesSecret = config.get<string>('SES_AWS_SECRET_ACCESS_KEY')?.trim();
  if (sesKeyId || sesSecret) {
    if (!sesKeyId || !sesSecret) {
      throw new Error(
        'EmailTransport: SES_AWS_ACCESS_KEY_ID and SES_AWS_SECRET_ACCESS_KEY must be set together.',
      );
    }
    return { accessKeyId: sesKeyId, secretAccessKey: sesSecret, source: 'dedicated' };
  }
  const appEnv = (config.get<string>('APP_ENV') ?? '').toUpperCase();
  if (LIVE_APP_ENVS.includes(appEnv)) {
    throw new Error(
      `EmailTransport: APP_ENV=${appEnv} sends SES email only with SES_AWS_ACCESS_KEY_ID and ` +
        'SES_AWS_SECRET_ACCESS_KEY. The shared AWS key is not used for email here.',
    );
  }
  const accessKeyId = config.get<string>('AWS_ACCESS_KEY_ID');
  const secretAccessKey = config.get<string>('AWS_SECRET_ACCESS_KEY');
  if (accessKeyId && secretAccessKey) return { accessKeyId, secretAccessKey, source: 'shared' };
  return undefined;
}

/**
 * AWS SES v2 transport (`@aws-sdk/client-sesv2`). Requires AWS_REGION + EMAIL_FROM, and in
 * STAGING/PRODUCTION the dedicated SES key pair (see resolveSesCredentials).
 */
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
    const credentials = resolveSesCredentials(config);
    this.client = new SESv2Client({
      region,
      // Only the key itself: the source label is for readiness, not for the SDK.
      ...(credentials
        ? {
            credentials: {
              accessKeyId: credentials.accessKeyId,
              secretAccessKey: credentials.secretAccessKey,
            },
          }
        : {}),
      /*
        Bounded, because the SDK's default HTTP handler has no request timeout at all.

        Every notification goes through one worker with a concurrency of one, so a single socket
        that SES accepts and never answers would stall ticket emails, SMS and hold expiry behind
        it indefinitely. A timed-out send throws, and the dispatcher retries it on its schedule.
        The plain options object is the form the installed Smithy handler accepts directly.
      */
      requestHandler: { connectionTimeout: 5_000, requestTimeout: 10_000 },
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
        // Set by the email channel for the few types allowed one, after checking the address.
        ...(msg.replyTo ? { ReplyToAddresses: [msg.replyTo] } : {}),
        // Without this, SES publishes no events for the message and no callback ever arrives.
        ...(this.configurationSet ? { ConfigurationSetName: this.configurationSet } : {}),
        Content: {
          Simple: {
            Subject: { Data: msg.subject },
            // Text AND Html when there is HTML: SES sends a multipart/alternative message and
            // the client picks. The text part is never dropped - it is what a text-only
            // reader sees, and a genuine sender having both is also what spam filters expect.
            Body: {
              Text: { Data: msg.body },
              ...(msg.html ? { Html: { Data: msg.html } } : {}),
            },
            // Marketing mail only: the one-click unsubscribe pair. See `listUnsubscribeHeaders`.
            ...(listUnsubscribeHeaders(msg)
              ? {
                  Headers: Object.entries(listUnsubscribeHeaders(msg)!).map(([Name, Value]) => ({
                    Name,
                    Value,
                  })),
                }
              : {}),
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

/**
 * The unsubscribe headers to send, or null.
 *
 * Only the two RFC 8058 names pass, only with an https URL in angle brackets, and never with
 * a line break in them (a CR or LF would let a value start a header of its own). Anything
 * else is dropped and the message still goes, the same rule as links in `link-safety.ts`.
 */
export function listUnsubscribeHeaders(msg: RenderedNotification): Record<string, string> | null {
  const h = msg.listUnsubscribe;
  if (!h) return null;
  const value = h['List-Unsubscribe'];
  // `\s` covers CR and LF, so a value cannot smuggle in a header line of its own.
  if (typeof value !== 'string' || !/^<https:\/\/[^<>\s]+>$/.test(value)) return null;
  const out: Record<string, string> = { 'List-Unsubscribe': value };
  if (h['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click') {
    out['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  return out;
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
