import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import {
  listUnsubscribeHeaders,
  resolveSesCredentials,
} from '../notifications/channels/transports/email.transport';
import type { RenderedNotification } from '../notifications/channels/notification-channel.interface';

/**
 * How a campaign message leaves the platform. Separate from the notification transport on
 * purpose: its own From address, its own SES configuration set, its own queue and rate limit,
 * so campaign volume can never delay or taint a ticket email.
 */
export const CAMPAIGN_TRANSPORT = Symbol('CAMPAIGN_TRANSPORT');

export interface CampaignMessage {
  to: string;
  from: string;
  replyTo: string | null;
  subject: string;
  html: string;
  text: string;
  configurationSet: string | null;
  listUnsubscribe: { 'List-Unsubscribe': string; 'List-Unsubscribe-Post'?: string };
}

export interface CampaignTransport {
  readonly name: 'ses' | 'log';
  /** Resolves with the provider's id when it ACCEPTED the message. Throws otherwise. */
  send(msg: CampaignMessage): Promise<{ provider: string; providerMessageId: string }>;
}

/**
 * Why a send failed, in the three shapes the dispatcher acts on:
 *   - REJECTED: the provider will never take THIS message (bad address, content refused).
 *     The recipient fails, nothing is spent, nothing is retried.
 *   - ACCOUNT: the provider will take nothing at all right now (account paused or suspended,
 *     sender not verified). The campaign pauses; retrying each recipient would only fail each.
 *   - TRANSIENT: throttled, timed out, a 5xx. Retried with backoff.
 */
export type SendFailureKind = 'REJECTED' | 'ACCOUNT' | 'TRANSIENT';

const REJECTED = new Set(['MessageRejected', 'BadRequestException', 'InvalidParameterValue']);
const ACCOUNT = new Set([
  'AccountSuspendedException',
  'SendingPausedException',
  'MailFromDomainNotVerifiedException',
  'NotFoundException',
  'AccessDeniedException',
]);

export function classifySendError(err: unknown): SendFailureKind {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  const name = e?.name ?? '';
  if (REJECTED.has(name)) return 'REJECTED';
  if (ACCOUNT.has(name)) return 'ACCOUNT';
  const status = e?.$metadata?.httpStatusCode;
  if (status && status >= 400 && status < 500 && status !== 429) return 'REJECTED';
  return 'TRANSIENT';
}

/** A short, address-free reason for the recipient row. */
export function sendErrorSummary(err: unknown): string {
  const e = err as { name?: string; message?: string } | null;
  const name = e?.name || 'Error';
  const message = (e?.message ?? '').replace(/[^\s@<>]+@[^\s@<>]+/g, '[address]').slice(0, 200);
  return `${name}: ${message}`.slice(0, 300);
}

/** Logs the message and accepts it. LOCAL, DEV, QA, UAT only (campaign-sending-config.ts). */
export class LogCampaignTransport implements CampaignTransport {
  readonly name = 'log' as const;
  private readonly logger = new Logger('CampaignMail');
  async send(msg: CampaignMessage) {
    const [local, domain] = msg.to.split('@');
    this.logger.log(`[campaign] -> ${local.slice(0, 2)}***@${domain ?? ''} :: ${msg.subject}`);
    return { provider: 'log', providerMessageId: `log-${randomUUID()}` };
  }
}

export class SesCampaignTransport implements CampaignTransport {
  readonly name = 'ses' as const;
  private readonly client: SESv2Client;

  constructor(config: ConfigService) {
    const region = config.get<string>('AWS_REGION');
    if (!region) throw new Error('Campaign SES transport needs AWS_REGION.');
    const credentials = resolveSesCredentials(config);
    this.client = new SESv2Client({
      region,
      ...(credentials
        ? {
            credentials: {
              accessKeyId: credentials.accessKeyId,
              secretAccessKey: credentials.secretAccessKey,
            },
          }
        : {}),
      requestHandler: { connectionTimeout: 5_000, requestTimeout: 10_000 },
    });
  }

  async send(msg: CampaignMessage) {
    // The same header guard the notification transports use: https only, no line breaks.
    const headers = listUnsubscribeHeaders({
      listUnsubscribe: msg.listUnsubscribe,
    } as unknown as RenderedNotification);
    if (!headers)
      throw Object.assign(new Error('Unsubscribe header refused.'), {
        name: 'BadRequestException',
      });
    const res = await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: msg.from,
        Destination: { ToAddresses: [msg.to] },
        ...(msg.replyTo ? { ReplyToAddresses: [msg.replyTo] } : {}),
        ...(msg.configurationSet ? { ConfigurationSetName: msg.configurationSet } : {}),
        EmailTags: [{ Name: 'stream', Value: 'campaign' }],
        Content: {
          Simple: {
            Subject: { Data: msg.subject },
            Body: { Text: { Data: msg.text }, Html: { Data: msg.html } },
            Headers: Object.entries(headers).map(([Name, Value]) => ({ Name, Value })),
          },
        },
      }),
    );
    if (!res.MessageId) throw new Error('SES accepted the request but returned no message id.');
    return { provider: 'ses', providerMessageId: res.MessageId };
  }
}

/** The transport for this deployment. Built lazily: SES keys are needed only when used. */
export function selectCampaignTransport(config: ConfigService): CampaignTransport {
  return (config.get<string>('EMAIL_PROVIDER') ?? 'log') === 'ses'
    ? new SesCampaignTransport(config)
    : new LogCampaignTransport();
}
